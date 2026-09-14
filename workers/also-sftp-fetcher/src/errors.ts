/**
 * C.3.4.4 — also-sftp-fetcher: códigos de erro estáveis + mensagens seguras.
 *
 * Módulo PURO (sem APIs de Worker/Node): é importado pelo worker E pela app
 * Next.js (via path relativo), para que a política de erros seja UMA só e não
 * derive entre os dois deploy units. As mensagens são estáticas — nunca podem
 * conter passwords, host keys, bytes do remoto, paths ou stack.
 *
 * Os textos PT aqui são os MESMOS da tabela da app
 * (src/lib/supplier-import/error-messages.ts); se um texto mudar, muda nos dois.
 */

/** Todos os códigos que o transporte SFTP pode produzir. */
export const SFTP_ERROR_CODES = [
  "SFTP_CONFIG_INVALID",
  "SFTP_HOST_NOT_ALLOWED",
  "SFTP_HOST_KEY_MISMATCH",
  "SFTP_AUTH_FAILED",
  "SFTP_SECRET_MISSING",
  "SFTP_FILE_NOT_FOUND",
  "SFTP_PERMISSION_DENIED",
  "SFTP_TOO_LARGE",
  "SFTP_TIMEOUT",
  "SFTP_FETCH_FAILED",
  "SFTP_PROTOCOL_ERROR",
  "SFTP_BINDING_UNAVAILABLE",
  "SFTP_NO_CHANGE",
] as const;
export type SftpErrorCode = (typeof SFTP_ERROR_CODES)[number];

/** Códigos que justificam nova tentativa (rede/transiente). Mais nada. */
export const SFTP_RETRYABLE_CODES: readonly SftpErrorCode[] = [
  "SFTP_TIMEOUT",
  "SFTP_FETCH_FAILED",
] as const;

export function isSftpRetryableCode(code: string): boolean {
  return (SFTP_RETRYABLE_CODES as readonly string[]).includes(code);
}

export const SFTP_SAFE_MESSAGES: Record<SftpErrorCode, string> = {
  SFTP_CONFIG_INVALID:
    "Configuração SFTP inválida (host, porta, caminho, utilizador, referência do secret ou pin da host key).",
  SFTP_HOST_NOT_ALLOWED:
    "O host SFTP não está na allowlist do worker de transporte — nada foi transferido.",
  SFTP_HOST_KEY_MISMATCH:
    "A host key do servidor SFTP não corresponde ao pin configurado — ligação abortada antes de qualquer transferência.",
  SFTP_AUTH_FAILED:
    "O servidor SFTP recusou as credenciais — verifique o utilizador e o secret no worker de transporte.",
  SFTP_SECRET_MISSING:
    "O segredo SFTP não está disponível no worker de transporte — verifique a referência do secret (o valor nunca é guardado na aplicação).",
  SFTP_FILE_NOT_FOUND: "O ficheiro remoto SFTP não existe no caminho configurado.",
  SFTP_PERMISSION_DENIED: "O servidor SFTP negou acesso ao ficheiro remoto (leitura).",
  SFTP_TOO_LARGE: "O ficheiro remoto SFTP excede o limite de 5 MB — nada foi importado.",
  SFTP_TIMEOUT: "O servidor SFTP não respondeu dentro do limite de tempo.",
  SFTP_FETCH_FAILED: "Falha ao obter o ficheiro SFTP — tente novamente mais tarde.",
  SFTP_PROTOCOL_ERROR: "O servidor SFTP respondeu de forma inesperada — nada foi importado.",
  SFTP_BINDING_UNAVAILABLE:
    "O worker de transporte SFTP (also-sftp-fetcher) não está ligado a esta aplicação — falta a service binding.",
  SFTP_NO_CHANGE: "Nenhuma alteração no ficheiro remoto SFTP desde a última sincronização.",
};

/** Mensagem segura para `code`; códigos desconhecidos caem no genérico. */
export function sftpErrorMessage(code: string): string {
  return (
    (SFTP_SAFE_MESSAGES as Record<string, string>)[code] ?? SFTP_SAFE_MESSAGES.SFTP_FETCH_FAILED
  );
}

/** Erro tipado do transporte: código estável + flag de retry. */
export class SftpError extends Error {
  readonly retryable: boolean;
  constructor(
    readonly code: SftpErrorCode,
    options: { retryable?: boolean } = {}
  ) {
    super(code);
    this.name = "SftpError";
    this.retryable = options.retryable ?? isSftpRetryableCode(code);
  }
}
