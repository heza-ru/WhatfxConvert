import './globals.css';

export const metadata = {
  title: 'OdArc Converter',
  description: 'Convert .odarc files to annotated PDF guides',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
