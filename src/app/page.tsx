import type { Metadata } from "next";
import { LandingPage } from "./landing/LandingPage";
import { computeLandingData, ZERO_LANDING } from "./votive/data";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Votive · DCA into superintelligence",
  description:
    "Park crypto against a job today's AI can't do yet. On every new model release the frontier takes another run at it; the moment it can, your wish fulfils. 2% a year on parked funds, 8% of realised proceeds, nothing else.",
};

export default async function Home() {
  let data = ZERO_LANDING;
  try {
    data = await computeLandingData();
  } catch {

  }
  return <LandingPage d={data} />;
}
