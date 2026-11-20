// Tipos do script de provisionamento (JavaScript puro, executado sem build).
export declare const RUNTIME_GROUP_ROLE: 'finbank_runtime';
export declare const SCRAM_ITERATIONS: number;
export declare const ROLE_NAME_PATTERN: RegExp;
export declare const PASSWORD_PATTERN: RegExp;

export declare class ProvisionError extends Error {}

export declare function parseProvisionEnv(env: Readonly<Record<string, string | undefined>>): {
  readonly user: string;
  readonly password: string;
};

export declare function scramVerifier(password: string, salt?: Buffer, iterations?: number): string;

export declare function provisionSql(user: string, verifier: string): string;

export declare function provision(env: Readonly<Record<string, string | undefined>>, cwd?: string): string;
