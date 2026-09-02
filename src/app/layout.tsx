import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "MDTech Solutions — Informática, Reparação e Tecnologia em Esposende",
  description: "Loja online de informática, reparação de computadores, assistência técnica e venda de tecnologia. Marco Duarte Tech Solutions, Esposende, Portugal.",
  keywords: "informática, reparação computadores, assistência técnica, Esposende, portáteis, gaming, componentes PC",
  openGraph: {
    title: "MDTech Solutions",
    description: "Reparação Rápida. Soluções Completas.",
    type: "website",
    locale: "pt_PT",
  },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="pt">
      <head>
        <link rel="icon" href="/favicon.ico" />
        <meta name="theme-color" content="#0284c7" />
      </head>
      <body className="bg-white text-slate-900 antialiased">{children}</body>
    </html>
  );
}
