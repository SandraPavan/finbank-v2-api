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

  it('nenhum outro módulo depende dela, salvo a raiz e as rotas de administração, da configuração educacional, da inscrição, do onboarding e do relógio', () => {
    const users = files.filter((f) => !f.path.startsWith('access/') && imports(f.text).some((s) => /\/access\//.test(s)));
    expect(users.map((f) => f.path).sort()).toEqual([
      'administration/http/facilitator-customers.controller.ts',
      'app.module.ts',
      'education/http/educational-config.controller.ts',
      'enrollment/http/enrollment.controller.ts',
      'onboarding/http/onboarding.controller.ts',
      'simulation-clock/http/simulation-clock.controller.ts',
    ]);
  });

  it('o controller não lê o identificador do caminho', () => {
    const controllers = module.filter((f) => /@Controller\(/.test(f.text));
    expect(controllers).toHaveLength(1);
    expect(controllers[0]?.text).not.toMatch(/@Param\(|@Req\(|\.params/);
  });
});

describe('arquitetura da administração', () => {
  const module = files.filter((f) => f.path.startsWith('administration/'));

  it('domínio e aplicação não importam NestJS, Prisma, HTTP, Node nem infraestrutura', () => {
    const inner = module.filter((f) => /^administration\/(domain|application)\//.test(f.path));
    expect(inner.length).toBeGreaterThan(0);
    for (const file of inner) {
      for (const spec of imports(file.text)) {
        expect(spec, file.path).not.toMatch(/^@nestjs|^@prisma|^node:|generated|persistence|adapters|express|http|cli/);
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

  it('as operações do operador só são usadas pela linha de comando', () => {
    const users = files.filter((f) => imports(f.text).some((s) => /operator\.service|prisma-operator\.store|\/cli\//.test(s)));
    expect(users.map((f) => f.path).sort()).toEqual(['admin.ts', 'administration/cli/run-command.ts']);
    expect(files.filter((f) => imports(f.text).some((s) => /\/admin\.js$/.test(s)))).toEqual([]);
    const cli = files.filter((f) => f.path === 'admin.ts' || f.path.startsWith('administration/cli/'));
    for (const file of cli) {
      expect(file.text, file.path).not.toMatch(/@nestjs|NestFactory|listen\(|node:http/);
    }
  });

  it('nada fora da linha de comando e da migração cria identidade, credencial, vínculo ou workspace', () => {
    const writers = files.filter((f) => /INSERT INTO "(user_identity|password_credential|workspace_membership|workspace)"/.test(f.text));
    expect(writers.map((f) => f.path)).toEqual(['administration/adapters/prisma-operator.store.ts']);
  });
});

describe('arquitetura dos modos educacionais', () => {
  const module = files.filter((f) => f.path.startsWith('education/'));
  const domain = module.filter((f) => !f.path.slice('education/'.length).includes('/') && f.path !== 'education/education.module.ts');

  it('o domínio é puro: além de si mesmo, só importa o tipo de acesso confirmado e o hash do Node', () => {
    expect(domain.map((f) => f.path).sort()).toEqual(['education/defect-catalog.ts', 'education/educational-mode.ts', 'education/educational-policy.ts']);
    for (const file of domain) {
      for (const spec of imports(file.text)) {
        expect(spec, file.path).toMatch(/^\.\/[a-z-]+\.js$|^\.\.\/identity\/domain\/workspace-access\.js$|^node:crypto$/);
      }
      expect(file.text, file.path).not.toMatch(/console\.|Logger|process\.env|Math\.random|Date\.now/);
    }
  });

  it('a aplicação não importa NestJS, Prisma, HTTP nem adaptadores', () => {
    for (const file of module.filter((f) => f.path.startsWith('education/application/'))) {
      for (const spec of imports(file.text)) {
        expect(spec, file.path).not.toMatch(/^@nestjs|^@prisma|^node:|generated|persistence|adapters|http/);
      }
    }
  });

  it('só a raiz o compõe; nenhum outro módulo, financeiro ou não, depende dele', () => {
    const users = files.filter((f) => !f.path.startsWith('education/') && imports(f.text).some((s) => /\/education\//.test(s)));
    expect(users.map((f) => f.path)).toEqual(['app.module.ts']);
    for (const file of module) {
      expect(imports(file.text).join(' '), file.path).not.toMatch(/payment-execution|reconciliation|administration|authentication/);
    }
  });
});

describe('arquitetura do relógio simulado', () => {
  const module = files.filter((f) => f.path.startsWith('simulation-clock/'));

  it('o domínio é puro e não lê o relógio real nem o fuso do processo', () => {
    const domain = module.filter((f) => f.path.startsWith('simulation-clock/domain/'));
    expect(domain.map((f) => f.path)).toEqual(['simulation-clock/domain/business-date.ts']);
    for (const file of domain) {
      expect(imports(file.text), file.path).toEqual([]);
      expect(file.text, file.path).not.toMatch(/new Date|Date\.now|Intl\.|process\.env|console\.|Logger/);
    }
  });

  it('a aplicação não importa NestJS, Prisma, HTTP nem adaptadores, e não lê o relógio real', () => {
    const application = module.filter((f) => f.path.startsWith('simulation-clock/application/'));
    expect(application.length).toBeGreaterThan(0);
    for (const file of application) {
      for (const spec of imports(file.text)) {
        expect(spec, file.path).not.toMatch(/^@nestjs|^@prisma|^node:|generated|persistence|adapters|http/);
      }
      expect(file.text, file.path).not.toMatch(/new Date|Date\.now/);
    }
  });

  it('não depende dos módulos financeiros, educacionais ou de autenticação, nem escreve saldos', () => {
    for (const file of module) {
      expect(imports(file.text).join(' '), file.path).not.toMatch(/payment-execution|reconciliation|education|administration|authentication/);
      expect(file.text, file.path).not.toMatch(FINANCIAL_WRITE);
    }
  });

  it('autenticação, sessões e credenciais não dependem do relógio simulado', () => {
    const users = files.filter((f) => !f.path.startsWith('simulation-clock/') && imports(f.text).some((s) => /simulation-clock/.test(s)));
    expect(users.map((f) => f.path).sort()).toEqual(['app.module.ts', 'http/openapi.ts', 'onboarding/onboarding.module.ts']);
  });
});

describe('arquitetura da inscrição', () => {
  const module = files.filter((f) => f.path.startsWith('enrollment/'));

  it('o domínio só importa a modalidade e o hash e a aleatoriedade do Node', () => {
    const domain = module.filter((f) => f.path.startsWith('enrollment/domain/'));
    expect(domain.map((f) => f.path)).toEqual(['enrollment/domain/enrollment-code.ts']);
    for (const file of domain) {
      for (const spec of imports(file.text)) {
        expect(spec, file.path).toMatch(/^node:crypto$|^\.\.\/\.\.\/identity\/domain\/workspace-modality\.js$/);
      }
      expect(file.text, file.path).not.toMatch(/Math\.random|console\.|Logger|process\.env/);
    }
  });

  it('a aplicação não importa NestJS, Prisma, HTTP, Node nem adaptadores', () => {
    const application = module.filter((f) => f.path.startsWith('enrollment/application/'));
    expect(application.length).toBeGreaterThan(0);
    for (const file of application) {
      for (const spec of imports(file.text)) {
        expect(spec, file.path).not.toMatch(/^@nestjs|^@prisma|^node:|generated|persistence|adapters|http/);
      }
    }
  });

  it('não depende dos módulos financeiros, educacionais, de autenticação ou do relógio, nem registra logs', () => {
    for (const file of module) {
      expect(imports(file.text).join(' '), file.path).not.toMatch(/payment-execution|reconciliation|education|administration|authentication|simulation-clock/);
      expect(file.text, file.path).not.toMatch(FINANCIAL_WRITE);
      expect(file.text, file.path).not.toMatch(/console\.|Logger/);
    }
  });

  it('só a raiz e a composição do onboarding o usam', () => {
    const users = files.filter((f) => !f.path.startsWith('enrollment/') && imports(f.text).some((s) => /\/enrollment\//.test(s)));
    expect(users.map((f) => f.path).sort()).toEqual(['app.module.ts', 'onboarding/onboarding.module.ts']);
  });
});

describe('arquitetura do onboarding', () => {
  const module = files.filter((f) => f.path.startsWith('onboarding/'));

  it('o domínio é puro: só valida formatos, sem relógio real, fuso, rede ou logs', () => {
    const domain = module.filter((f) => f.path.startsWith('onboarding/domain/'));
    expect(domain.map((f) => f.path)).toEqual(['onboarding/domain/onboarding-request.ts']);
    for (const file of domain) {
      for (const spec of imports(file.text)) {
        expect(spec, file.path).toMatch(/^\.\.\/\.\.\/identity\/domain\/email\.js$|^\.\.\/\.\.\/authentication\/domain\/password-policy\.js$/);
      }
      expect(file.text, file.path).not.toMatch(/new Date|Date\.now|Intl\.|process\.env|console\.|Logger/);
    }
  });

  it('a aplicação depende só de portas, sem NestJS, Prisma, Node, HTTP ou outros módulos', () => {
    const application = module.filter((f) => f.path.startsWith('onboarding/application/'));
    expect(application.length).toBeGreaterThan(0);
    for (const file of application) {
      for (const spec of imports(file.text)) {
        expect(spec, file.path).toMatch(/^\.\.\/domain\//);
      }
    }
  });

  it('não escreve saldos, identidades, contas nem registra logs; só a raiz o compõe', () => {
    for (const file of module) {
      expect(imports(file.text).join(' '), file.path).not.toMatch(/payment-execution|reconciliation|education|administration/);
      expect(file.text, file.path).not.toMatch(FINANCIAL_WRITE);
      expect(file.text, file.path).not.toMatch(/INSERT INTO "(user_identity|password_credential|workspace|account)"/);
      expect(file.text, file.path).not.toMatch(/console\.|Logger/);
    }
    const users = files.filter((f) => !f.path.startsWith('onboarding/') && imports(f.text).some((s) => /\/onboarding\//.test(s)));
    expect(users.map((f) => f.path)).toEqual(['app.module.ts']);
  });
});
