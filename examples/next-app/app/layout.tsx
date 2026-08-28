export const metadata = { title: "bun-img × next/image" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body style={{ font: "16px/1.6 system-ui, sans-serif", maxWidth: "70ch", margin: "4rem auto", padding: "0 1.5rem" }}>
        {children}
      </body>
    </html>
  );
}
