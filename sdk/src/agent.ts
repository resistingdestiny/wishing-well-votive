/**
 * The out-of-the-box agent.
 *
 * Somebody writing a wish-fulfilling agent should not have to learn how our
 * contracts encode a claim, or how Hedera denominates HBAR, or what an x402
 * handshake looks like. They should get a toolbelt, hand it to a model, and have
 * the model be able to do the job.
 *
 * So this module is a thin assembly: a rail, the payment skills, the two calls an
 * agent makes against the bounty rail, and a set of tool definitions in the shape
 * every LLM tool-calling API expects. Nothing here has any judgement in it — the
 * model decides what to do, the skills refuse anything the founder did not sign.
 */
import type {HederaRail} from './rail.js';
import {tinybarsToHbar} from './rail.js';
import {type FetchLike, type SkillOutcome, payHbar, x402Buy} from './skills/pay.js';

// ------------------------------------------------------------------ tool shapes

/** A tool definition in the shape LLM tool-calling APIs expect. Deliberately
 *  plain JSON Schema so it can be handed to any of them unchanged. */
export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, {type: string; description: string}>;
    required: string[];
  };
}

export interface ToolCallResult {
  tool: string;
  ok: boolean;
  summary: string;
  detail?: unknown;
}

// --------------------------------------------------------- the bounty rail side

/** The two calls an agent makes against `AgentBountyRail`, kept as an interface so
 *  an agent can be tested without a chain. */
export interface BountyClient {
  claim(bountyId: bigint): Promise<{transactionHash: string}>;
  withdraw(): Promise<{transactionHash: string}>;
  credited(payout: string): Promise<bigint>;
}

/** Calldata for the rail's agent-facing functions.
 *
 *  Hand-encoded rather than pulled in through a full EVM client library: these are
 *  two functions with one static argument between them, and an agent runtime should
 *  not need a dependency the size of a web3 stack to call them. */
export const railCalldata = {
  /** `claim(uint256)` */
  claim(bountyId: bigint): string {
    return `0x379607f5${bountyId.toString(16).padStart(64, '0')}`;
  },
  /** `withdraw()` */
  withdraw(): string {
    return '0x3ccfd60b';
  },
  /** `credited(address)` */
  credited(payout: string): string {
    return `0xfdf60ec7${payout.replace(/^0x/, '').toLowerCase().padStart(64, '0')}`;
  },
} as const;

// ------------------------------------------------------------------- the agent

export interface VotiveAgentConfig {
  rail: HederaRail;
  /** Optional: needed only by the bounty tools. */
  bounty?: BountyClient;
  /** Defaults to global fetch. Injectable so x402 can be tested. */
  fetchImpl?: FetchLike;
}

export interface VotiveAgent {
  readonly rail: HederaRail;
  /** Every tool this agent can perform, ready to hand to a model. */
  tools(): ToolDefinition[];
  /** Perform one tool call by name. Unknown names are refused rather than
   *  guessed at, because a model that misremembers a tool name should get an
   *  error and not an approximation. */
  call(tool: string, input: Record<string, unknown>): Promise<ToolCallResult>;
  /** Run a signed instruction directly, without a model in the loop. */
  run(instruction: string): Promise<SkillOutcome>;
}

const TOOLS: ToolDefinition[] = [
  {
    name: 'hedera_pay',
    description:
      'Send HBAR on Hedera to settle something the wish authorised — a supplier, a '
      + 'service, another agent. Takes a signed instruction of the form '
      + 'pay:<accountId>:<hbar>:<memo>. Refuses anything that is not a valid Hedera '
      + 'account id. The payment is confirmed at consensus before it reports success.',
    input_schema: {
      type: 'object',
      properties: {
        instruction: {
          type: 'string',
          description: 'The signed instruction, e.g. pay:0.0.4242:1.5:invoice 7',
        },
      },
      required: ['instruction'],
    },
  },
  {
    name: 'hedera_x402_buy',
    description:
      'Buy exactly one use of an HTTP API that prices itself with a 402 response, '
      + 'paying on Hedera. Use this for a paid API you have no account with — there is '
      + 'no key and no subscription. Takes buy:<url>:<maxHbar>:<memo>; the cap is a hard '
      + 'limit and a service asking for more is not paid. Returns the response body.',
    input_schema: {
      type: 'object',
      properties: {
        instruction: {
          type: 'string',
          description: 'The signed instruction, e.g. buy:https://api.example.com/x:0.5:render',
        },
      },
      required: ['instruction'],
    },
  },
  {
    name: 'votive_claim_bounty',
    description:
      'Take exclusive responsibility for a bounty you intend to complete. Claim before '
      + 'starting work: the claim is exclusive, so no other agent will be paid for the '
      + 'same task, and it lapses if you do not finish within the window.',
    input_schema: {
      type: 'object',
      properties: {
        bountyId: {type: 'string', description: 'The bounty id, as a decimal string'},
      },
      required: ['bountyId'],
    },
  },
  {
    name: 'votive_withdraw_earnings',
    description:
      'Collect everything credited to your payout address from completed milestones. '
      + 'One call however many milestones it came from.',
    input_schema: {type: 'object', properties: {}, required: []},
  },
];

export function createVotiveAgent(config: VotiveAgentConfig): VotiveAgent {
  const fetchImpl = config.fetchImpl ?? (fetch as unknown as FetchLike);

  async function run(instruction: string): Promise<SkillOutcome> {
    if (instruction.startsWith('pay:')) return payHbar(config.rail, instruction);
    if (instruction.startsWith('buy:')) return x402Buy(config.rail, instruction, fetchImpl);
    return {
      skill: 'unknown',
      ok: false,
      summary: 'no skill handles that instruction',
      error: `unrecognised instruction prefix: ${instruction.split(':')[0] ?? ''}`,
    };
  }

  function needBounty(): BountyClient {
    if (!config.bounty) {
      throw new Error(
        'this agent was created without a bounty client, so it cannot claim or withdraw'
      );
    }
    return config.bounty;
  }

  return {
    rail: config.rail,

    tools() {
      // Hide the bounty tools when the agent has no way to perform them, rather
      // than offering a model a tool that is guaranteed to fail.
      return config.bounty ? TOOLS : TOOLS.filter((t) => !t.name.startsWith('votive_'));
    },

    async call(tool, input) {
      try {
        switch (tool) {
          case 'hedera_pay':
          case 'hedera_x402_buy': {
            const instruction = String(input.instruction ?? '');
            const outcome = await run(instruction);
            return {tool, ok: outcome.ok, summary: outcome.summary, detail: outcome};
          }
          case 'votive_claim_bounty': {
            const id = BigInt(String(input.bountyId ?? '0'));
            const {transactionHash} = await needBounty().claim(id);
            return {tool, ok: true, summary: `claimed bounty ${id}`, detail: {transactionHash}};
          }
          case 'votive_withdraw_earnings': {
            const client = needBounty();
            const before = await client.credited(config.rail.accountId).catch(() => 0n);
            const {transactionHash} = await client.withdraw();
            return {
              tool,
              ok: true,
              summary:
                before > 0n
                  ? `withdrew ${tinybarsToHbar(before)} ℏ of earnings`
                  : 'withdrew earnings',
              detail: {transactionHash},
            };
          }
          default:
            return {tool, ok: false, summary: `no such tool: ${tool}`};
        }
      } catch (error) {
        return {
          tool,
          ok: false,
          summary: 'the tool call failed',
          detail: {error: error instanceof Error ? error.message : String(error)},
        };
      }
    },

    run,
  };
}
