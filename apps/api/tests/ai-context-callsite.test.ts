import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const API_SRC = path.resolve(__dirname, "..", "src");
const EXPECTED_AI_CALLS = 30;

type AiCallsite = {
  file: string;
  line: number;
  node: ts.CallExpression;
};

function sourceFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(fullPath));
    else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith(".d.ts")) files.push(fullPath);
  }
  return files;
}

function isAiFactoryCall(node: ts.CallExpression): boolean {
  const callee = node.expression;
  const ai = ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee) ? callee.expression : undefined;
  return (
    ai !== undefined &&
    ts.isPropertyAccessExpression(ai) &&
    ai.name.text === "Ai" &&
    ts.isIdentifier(ai.expression) &&
    ai.expression.text === "u"
  );
}

function hasContextImport(sourceFile: ts.SourceFile): boolean {
  return sourceFile.statements.some(
    (statement) =>
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text === "@/billing/context" &&
      statement.importClause?.namedBindings !== undefined &&
      ts.isNamedImports(statement.importClause.namedBindings) &&
      statement.importClause.namedBindings.elements.some((element) => element.name.text === "currentAiBillingContext"),
  );
}

function isContextCall(node: ts.Expression | undefined): boolean {
  return (
    node !== undefined &&
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "currentAiBillingContext" &&
    node.arguments.length === 0
  );
}

describe("AI billing context callsite inventory", () => {
  it("covers every u.Ai fixed or computed constructor call exactly once", () => {
    const callsites: AiCallsite[] = [];
    const files = sourceFiles(API_SRC);

    for (const file of files) {
      const source = fs.readFileSync(file, "utf8");
      const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
      const fileCalls: AiCallsite[] = [];
      const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node) && isAiFactoryCall(node)) {
          const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
          const callsite = { file: path.relative(API_SRC, file).split(path.sep).join("/"), line: line + 1, node };
          callsites.push(callsite);
          fileCalls.push(callsite);
        }
        ts.forEachChild(node, visit);
      };
      visit(sourceFile);

      if (fileCalls.length > 0) {
        expect(hasContextImport(sourceFile), `${path.relative(API_SRC, file)} must import currentAiBillingContext from @/billing/context`).toBe(
          true,
        );
      }
    }

    expect(callsites, "AST inventory of u.Ai fixed and computed invocations").toHaveLength(EXPECTED_AI_CALLS);
    const missingContext = callsites
      .filter(({ node }) => !isContextCall(node.arguments[1]))
      .map(({ file, line }) => `${file}:${line}`);
    expect(missingContext, "Each AI constructor must receive currentAiBillingContext() as its second argument").toEqual([]);
  });
});
