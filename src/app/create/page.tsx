import { CreateFlow } from "./CreateFlow";
import { PageHead } from "@/app/ui/PageHead";

export const metadata = {
  title: "Make a wish · Votive",
  description: "Tell Votive what you want in plain language; sign and fund exactly that schema.",
};

export default function CreatePage() {
  return (
    <main>
      <PageHead
        title="Make a wish"
        description="Four steps: write your wish in plain language, review the schema the agent parsed, fund it (wallet, any token, or ordinary money), then it waits for the frontier. 2% a year on parked funds · 8% of realised proceeds above principal, at resolution."
      />
      <CreateFlow />
    </main>
  );
}
