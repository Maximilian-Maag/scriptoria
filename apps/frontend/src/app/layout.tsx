import type { ReactNode } from "react";
import { Providers } from "@/lib/query";
import "./globals.css";
import "@xterm/xterm/css/xterm.css";

export const metadata = {
  title: "Scriptoria",
  description:
    "Select, start and drive the scripts on your service VMs, and collect what they produce.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="h-full">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
