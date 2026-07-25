import type { Metadata } from "next";
import { Space_Grotesk, JetBrains_Mono } from "next/font/google";
import { Providers } from "./Providers";
import { CommandPalette } from "./CommandPalette";
import { TopNav } from "./TopNav";
import { AppFooter } from "./AppFooter";
import { AppFx } from "./fx/AppFx";
import "./globals.css";

const grotesk = Space_Grotesk({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-display",
  display: "swap",
});
const mono = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "700"],
  variable: "--font-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Votive",
  description:
    "Votive is the well where wishes actually come true. Fund a wish in crypto with a plain-language story, and an AI agent tests every major model release and executes the moment it can.",
};

function GlassBlobs() {
  return (
    <div className="glassBlobs" aria-hidden="true">
      <span className="b1" />
      <span className="b2" />
      <span className="b3" />
    </div>
  );
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${grotesk.variable} ${mono.variable}`}>
      <body>
        <Providers>
          <GlassBlobs />
          <AppFx />
          <TopNav />
          {children}
          <AppFooter />
          <CommandPalette />
        </Providers>
      </body>
    </html>
  );
}
