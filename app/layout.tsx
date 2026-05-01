import type { Metadata } from 'next';
import './globals.css';
import MsalProvider from './providers/MsalProvider';

export const metadata: Metadata = {
  title: 'Claude Secure RAG Demo',
  description: 'Permission-aware Document Q&A using Entra ID + Azure AI Search + Claude'
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <MsalProvider>{children}</MsalProvider>
      </body>
    </html>
  );
}
