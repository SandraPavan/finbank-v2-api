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

describe('arquitetura da identidade', () => {
  const module = files.filter((f) => f.path.startsWith('identity/'));

  it('domínio e aplicação não importam NestJS, Prisma, HTTP nem infraestrutura', () => {
    const inner = module.filter((f) => /^identity\/(domain|application)\//.test(f.path));
    expect(inner.length).toBeGreaterThan(0);
    for (const file of inner) {
      for (const spec of imports(file.text)) {
        expect(spec, file.path).not.toMatch(/^@nestjs|^@prisma|generated|persistence|adapters|express/);
      }
      if (file.path.startsWith('identity/domain/')) {
        expect(imports(file.text).join(' '), file.path).not.toMatch(/application/);
      }
    }
  });

  it('não depende dos módulos financeiros nem dos modos educacionais', () => {
    for (const file of module) {
      for (const spec of imports(file.text)) {
        expect(spec, file.path).not.toMatch(/payment-execution|reconciliation|education/);
      }
    }
  });

  it('só lê e não declara controller', () => {
    const adapters = module.filter((f) => f.path.startsWith('identity/adapters/'));
    expect(adapters).toHaveLength(2);
    for (const adapter of adapters) {
      expect(adapter.text, adapter.path).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE)\b|\.(create|update|upsert|delete)/);
    }
    expect(module.some((f) => /@Controller\(|controllers\s*:/.test(f.text))).toBe(false);
  });
});

describe('arquitetura da autenticação', () => {
  const module = files.filter((f) => f.path.startsWith('authentication/'));

  it('domínio e aplicação não importam NestJS, Prisma, HTTP, criptografia nem infraestrutura', () => {
    const inner = module.filter((f) => /^authentication\/(domain|application)\//.test(f.path));
    expect(inner.length).toBeGreaterThan(0);
    for (const file of inner) {
      for (const spec of imports(file.text)) {
        expect(spec, file.path).not.toMatch(/^@nestjs|^@prisma|^node:|generated|persistence|adapters|express|http/);
      }
      if (file.path.startsWith('authentication/domain/')) {
        expect(imports(file.text).join(' '), file.path).not.toMatch(/application/);
      }
    }
  });

  it('não depende dos módulos financeiros nem dos modos educacionais, e não registra logs', () => {
    for (const file of module) {
      for (const spec of imports(file.text)) {
        expect(spec, file.path).not.toMatch(/payment-execution|reconciliation|education/);
      }
      expect(file.text, file.path).not.toMatch(/console\.|Logger/);
    }
  });

  it('só a pasta http declara controller, que não acessa persistência', () => {
    const controllers = module.filter((f) => /@Controller\(/.test(f.text));
    expect(controllers.map((f) => f.path)).toEqual(['authentication/http/authentication.controller.ts']);
    for (const file of module.filter((f) => f.path.startsWith('authentication/http/'))) {
      for (const spec of imports(file.text)) {
        expect(spec, file.path).not.toMatch(/prisma|generated|persistence/);
      }
    }
  });

  it('as rotas só usam login e troca de senha com limite de tentativas', () => {
    const controller = module.find((f) => f.path === 'authentication/http/authentication.controller.ts');
    expect(controller?.text).not.toMatch(/this\.auth\.(login|changePassword)/);
  });

  it('nenhum módulo habilita CORS', () => {
    for (const file of files) {
      expect(file.text, file.path).not.toMatch(/enableCors|cors\s*:/);
    }
  });
});

describe('arquitetura da autorização', () => {
  const module = files.filter((f) => f.path.startsWith('access/'));

  it('não acessa persistência, módulos financeiros ou modos educacionais, e não registra logs', () => {
    expect(module.length).toBeGreaterThan(0);
    for (const file of module) {
      for (const spec of imports(file.text)) {
        expect(spec, file.path).not.toMatch(/prisma|generated|persistence|payment-execution|reconciliation|education/);
      }
      expect(file.text, file.path).not.toMatch(/console\.|Logger/);
    }
  });

  it('nenhum outro módulo depende dela, salvo a raiz', () => {
    const users = files.filter((f) => !f.path.startsWith('access/') && imports(f.text).some((s) => /\/access\//.test(s)));
    expect(users.map((f) => f.path)).toEqual(['app.module.ts']);
  });

  it('o controller não lê o identificador do caminho', () => {
    const controllers = module.filter((f) => /@Controller\(/.test(f.text));
    expect(controllers).toHaveLength(1);
    expect(controllers[0]?.text).not.toMatch(/@Param\(|@Req\(|\.params/);
  });
});
