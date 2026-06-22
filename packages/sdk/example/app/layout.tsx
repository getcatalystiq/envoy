import type { ReactNode } from "react";

export const metadata = {
  title: "@catalystiq/envoy-sdk example",
  description: "Internal dogfood app for the Envoy Resend SDK",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
