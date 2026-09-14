import type { ReactNode } from "react";

/**
 * The backend is a Next.js app because NFR-11 requires both web tiers to be
 * Next.js. It serves an API and, later, the Swagger page — there is no product
 * UI here, and the one page it does render says so rather than pretending.
 */
export const metadata = {
  title: "Scriptoria — Control Plane",
  description: "REST API and terminal gateway. The user interface is the frontend on :3000.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
