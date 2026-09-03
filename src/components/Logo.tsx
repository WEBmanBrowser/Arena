import Image from "next/image";

/**
 * Logótipo oficial MDTech Solutions.
 *
 * Usa exatamente /public/logo.png — o ficheiro NÃO é recriado, editado nem
 * redesenhado. A imagem original (1536x1024, RGBA com transparência) tem uma
 * margem transparente generosa à volta do lockup; o conteúdo visível ocupa
 * apenas a caixa x[195..1353] y[291..692] (1159x402, rácio 2.883).
 *
 * Para o logótipo ficar legível em espaços pequenos (header, sidebar) sem
 * esticar nem deformar, recortamos essa margem transparente APENAS por CSS:
 * um contentor com overflow hidden dimensionado ao rácio do conteúdo, com a
 * imagem completa escalada proporcionalmente e deslocada. A proporção
 * original é sempre preservada (largura e altura derivam da mesma escala) e
 * a transparência do PNG mantém-se intacta.
 */

/** Dimensões reais do ficheiro. */
const FILE_W = 1536;
const FILE_H = 1024;

/** Caixa do conteúdo visível dentro do ficheiro (píxeis). */
const BOX_X = 195;
const BOX_Y = 291;
const BOX_W = 1159;
const BOX_H = 402;

/** Rácio do lockup visível — usado para calcular a largura a partir da altura. */
export const LOGO_ASPECT = BOX_W / BOX_H;

interface LogoProps {
  /** Altura visível do lockup, em píxeis. A largura é derivada da proporção. */
  height: number;
  /** Classes extra no contentor (ex.: responsividade). */
  className?: string;
  /** Carregar com prioridade (usar apenas no header). */
  priority?: boolean;
}

export default function Logo({ height, className = "", priority = false }: LogoProps) {
  // Escala aplicada à imagem completa para que o conteúdo fique com `height`.
  const scale = height / BOX_H;
  const renderedW = Math.round(FILE_W * scale);
  const renderedH = Math.round(FILE_H * scale);
  const width = Math.round(BOX_W * scale);

  return (
    <span
      className={`relative block overflow-hidden shrink-0 ${className}`}
      style={{ width, height }}
    >
      <Image
        src="/logo.png"
        alt="MDTech Solutions"
        width={renderedW}
        height={renderedH}
        priority={priority}
        className="max-w-none absolute"
        style={{
          left: -Math.round(BOX_X * scale),
          top: -Math.round(BOX_Y * scale),
        }}
      />
    </span>
  );
}
