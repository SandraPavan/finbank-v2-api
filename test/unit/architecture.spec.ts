// Regras de dependência e de escritor único de saldos, verificadas no código-fonte.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(import.meta.dirname, '..', '..', 'src');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      return name === 'generated' ? [] : sourceFiles(path);
    }
    return path.endsWith('.ts') ? [path] : [];
  });
}

const files = sourceFiles(SRC).map((path) => ({
  path: relative(SRC, path).split(sep).join('/'),
  text: readFileSync(path, 'utf8'),
}));

function imports(text: string): string[] {
  return [...text.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((match) => match[1] ?? '');
}

// Modelos e tabelas financeiras (nomes Prisma e SQL).
const FINANCIAL_WRITE =
  /\.(account|ledgerEntry|paymentOperation)\s*\.\s*(create|createMany|update|updateMany|upsert|delete|deleteMany)\b|\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM|TRUNCATE)\s+"?(account|ledger_entry|payment_operation)\b/i;

describe('arquitetura do PaymentExecution', () => {
  it('encontra os arquivos do módulo (sanidade do teste)', () => {
    expect(files.some((f) => f.path.startsWith('payment-execution/domain/'))).toBe(true);
    expect(files.some((f) => f.path.startsWith('payment-execution/adapters/'))).toBe(true);
  });

  it('domínio e aplicação não importam NestJS, Prisma, HTTP nem infraestrutura', () => {
    const inner = files.filter(
      (f) => f.path.startsWith('payment-execution/domain/') || f.path.startsWith('payment-execution/application/'),
    );
    expect(inner.length).toBeGreaterThan(0);
    for (const file of inner) {
      for (const spec of imports(file.text)) {
        expect(spec, file.path).not.toMatch(/^@nestjs|^@prisma|generated|persistence|adapters|express/);
      }
    }
  });

  it('o domínio não depende da aplicação', () => {
    for (const file of files.filter((f) => f.path.startsWith('payment-execution/domain/'))) {
      for (const spec of imports(file.text)) {
        expect(spec, file.path).not.toMatch(/application/);
      }
    }
  });

  it('somente o adaptador do PaymentExecution escreve em contas, operações ou ledger', () => {
    const writers = files.filter((f) => FINANCIAL_WRITE.test(f.text)).map((f) => f.path);
    expect(writers).toEqual(['payment-execution/adapters/prisma-payment-execution.store.ts']);
  });

  it('o módulo não declara controller (nenhuma rota financeira exposta)', () => {
    const moduleFile = files.find((f) => f.path === 'payment-execution/payment-execution.module.ts');
    expect(moduleFile?.text).not.toMatch(/controllers\s*:/);
    expect(files.some((f) => f.path.startsWith('payment-execution/') && /@Controller\(/.test(f.text))).toBe(false);
  });
});

describe('arquitetura da reconciliação', () => {
  const module = files.filter((f) => f.path.startsWith('reconciliation/'));

  it('encontra os arquivos do módulo (sanidade do teste)', () => {
    expect(module.some((f) => f.path.startsWith('reconciliation/domain/'))).toBe(true);
    expect(module.some((f) => f.path.startsWith('reconciliation/adapters/'))).toBe(true);
  });

  it('domínio e aplicação não importam NestJS, Prisma, HTTP nem infraestrutura', () => {
    const inner = module.filter(
      (f) => f.path.startsWith('reconciliation/domain/') || f.path.startsWith('reconciliation/application/'),
    );
    expect(inner.length).toBeGreaterThan(0);
    for (const file of inner) {
      for (const spec of imports(file.text)) {
        expect(spec, file.path).not.toMatch(/^@nestjs|^@prisma|generated|persistence|adapters|express/);
      }
    }
  });

  it('não depende do PaymentExecution', () => {
    for (const file of module) {
      for (const spec of imports(file.text)) {
        expect(spec, file.path).not.toMatch(/payment-execution/);
      }
    }
  });

  it('a leitura é somente leitura e não declara controller', () => {
    const adapter = module.find((f) => f.path === 'reconciliation/adapters/prisma-reconciliation.reader.ts');
    expect(adapter?.text).toMatch(/SET TRANSACTION READ ONLY/);
    expect(adapter?.text).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE)\b/);
    expect(module.some((f) => /@Controller\(|controllers\s*:/.test(f.text))).toBe(false);
  });
});
