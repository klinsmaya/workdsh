/** Extract exact literal references using the locked TypeScript public AST API. */
export function runtimeReferences(ts, text, file) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  // A single in-memory public CompilerHost; no libraries, dependency reads or
  // output. SourceFile.parseDiagnostics is an undeclared implementation field.
  const host = {
    getSourceFile: name => name === file ? source : undefined,
    getDefaultLibFileName: () => '', writeFile() { throw Error('runtime/scanner-emit-refused') },
    getCurrentDirectory: () => '', getDirectories: () => [], fileExists: name => name === file,
    readFile: name => name === file ? text : undefined, getCanonicalFileName: name => name,
    useCaseSensitiveFileNames: () => true, getNewLine: () => '\n',
  }
  const program = ts.createProgram([file], { allowJs: true, noResolve: true, noLib: true, noEmit: true,
    target: ts.ScriptTarget.Latest, module: ts.ModuleKind.ESNext }, host)
  if (program.getSyntacticDiagnostics(source).length) throw Error(`runtime/shipping-javascript-parse-refused:${file}`)
  const literals = [], dynamic = []
  const record = (argument, kind, node) => {
    if (argument && (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument))) {
      literals.push({ specifier: argument.text, kind, position: node.pos })
    } else dynamic.push({ kind, position: node.pos, expression: argument?.getText(source).slice(0, 512) ?? '<missing>' })
  }
  const walk = node => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier) record(node.moduleSpecifier, ts.isImportDeclaration(node) ? 'import' : 'export-from', node)
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      record(node.moduleReference.expression, 'import-equals', node)
    } else if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) record(node.arguments[0], 'dynamic-import', node)
      else if (ts.isIdentifier(node.expression) && node.expression.text === 'require') record(node.arguments[0], 'require', node)
      else if (ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.expression)
        && node.expression.expression.text === 'require' && node.expression.name.text === 'resolve') record(node.arguments[0], 'require.resolve', node)
    }
    ts.forEachChild(node, walk)
  }
  walk(source)
  return { literals, dynamic }
}
