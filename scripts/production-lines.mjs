#!/usr/bin/env node
/**
 * Counts Git additions + deletions and rejects production -> test imports.
 * Static literals are followed through the whole target tree, including aliases.
 * Dynamic loading, eval, filesystem reads and process execution are NOT an import
 * graph: their locations are reported separately, never certified as safe.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from 'typescript'
import { blankComments, kanariefåglar } from './lib/source-scan.mjs'

const SOURCE = /\.(?:[cm]?[jt]sx?|py)$/
const TEST =
  /(?:\.(?:spec|test|test-ports|test-helpers|test-fixtures)\.[cm]?[jt]sx?|(?:-test|_test)\.py)$/
const VROOT = '/__eken_counter__'
export function category(file) {
  if (TEST.test(file) || /(?:^|\/)e2e\//.test(file) || /(?:^|\/)test_[^/]+\.py$/.test(file))
    return 'test'
  if (/^(?:docs|arbete)\//.test(file) || /\.(?:md|mdx)$/.test(file)) return 'documentation'
  return 'production'
}
function git(root, args, input) {
  return execFileSync('git', ['-C', root, ...args], { input, maxBuffer: 256 * 1024 * 1024 })
}
export function numstat(bytes) {
  return bytes
    .toString()
    .split('\0')
    .filter(Boolean)
    .map((row) => {
      const match = /^(\d+|-)\t(\d+|-)\t([\s\S]+)$/.exec(row)
      if (!match || (match[1] === '-') !== (match[2] === '-'))
        throw new Error('Invalid git numstat record')
      return {
        file: match[3],
        added: match[1] === '-' ? null : Number(match[1]),
        deleted: match[2] === '-' ? null : Number(match[2]),
      }
    })
}
function targetTree(root, head) {
  const records = git(
    root,
    head
      ? ['ls-tree', '-rz', head]
      : ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
  )
    .toString()
    .split('\0')
    .filter(Boolean)
  const names = [...new Set(records.map((r) => (head ? r.slice(r.indexOf('\t') + 1) : r)))]
  const symlinks = new Set(
    head
      ? records.filter((r) => r.startsWith('120000 ')).map((r) => r.slice(r.indexOf('\t') + 1))
      : [],
  )
  if (names.some((f) => f.includes('\n')))
    throw new Error('Newline filenames are not supported by the historical Git batch reader')
  const wanted = names.filter(
    (f) => SOURCE.test(f) || /(?:^|\/)(?:package|tsconfig[^/]*)\.json$/.test(f),
  )
  const files = new Map()
  for (const file of wanted) {
    if (
      symlinks.has(file) ||
      (!head &&
        existsSync(path.join(root, file)) &&
        lstatSync(path.join(root, file)).isSymbolicLink())
    )
      throw new Error(`Source/config symlink is unsupported: ${file}`)
  }
  if (head) {
    const raw = git(root, ['cat-file', '--batch'], wanted.map((f) => `${head}:${f}\n`).join(''))
    let offset = 0
    for (const file of wanted) {
      const end = raw.indexOf(10, offset)
      const header = raw.subarray(offset, end).toString().split(' ')
      if (header[1] !== 'blob') throw new Error(`Cannot read ${head}:${file}`)
      const size = Number(header[2])
      files.set(file, raw.subarray(end + 1, end + 1 + size).toString())
      offset = end + size + 2
    }
  } else
    for (const file of wanted) {
      try {
        files.set(file, readFileSync(path.join(root, file), 'utf8'))
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
      }
    }
  return { files, names: new Set(names.filter((f) => head || existsSync(path.join(root, f)))) }
}
export function imports(files, names = new Set(files.keys())) {
  const errors = [],
    limitations = [],
    edges = new Map(),
    promoted = new Set()
  const absolute = (f) => path.posix.join(VROOT, f)
  const relative = (f) => path.posix.relative(VROOT, f)
  const host = {
    fileExists: (f) => files.has(relative(f)),
    readFile: (f) => files.get(relative(f)),
    readDirectory: () => [],
    useCaseSensitiveFileNames: true,
  }
  const configs = new Map(),
    packages = new Map()
  for (const [file, text] of files)
    if (/^(?:apps|packages)\/[^/]+\/package\.json$/.test(file)) {
      const pkg = JSON.parse(text)
      packages.set(pkg.name, { directory: path.posix.dirname(file), pkg })
    }
  function options(file) {
    let directory = path.posix.dirname(file)
    while (!files.has(path.posix.join(directory, 'tsconfig.json')) && directory !== '.')
      directory = path.posix.dirname(directory)
    const config = path.posix.join(directory, 'tsconfig.json')
    if (!configs.has(config)) {
      const parsed = ts.parseConfigFileTextToJson(config, files.get(config) ?? '{}')
      if (parsed.error) throw new Error(`Invalid configuration: ${config}`)
      const settings = ts.parseJsonConfigFileContent(parsed.config, host, absolute(directory))
      const invalid = settings.errors.filter((e) => ![18002, 18003].includes(e.code))
      if (invalid.length)
        throw new Error(
          `Invalid configuration: ${config}: ${invalid.map((e) => ts.flattenDiagnosticMessageText(e.messageText, ' ')).join('; ')}`,
        )
      configs.set(config, settings.options)
    }
    return configs.get(config)
  }
  function resolve(from, spec) {
    const opts = options(from)
    const resolved = ts.resolveModuleName(spec, absolute(from), opts, host).resolvedModule
      ?.resolvedFileName
    const targets = new Set(resolved && files.has(relative(resolved)) ? [relative(resolved)] : [])
    const candidates = [],
      patterns = Object.keys(opts.paths ?? {})
    for (const pattern of patterns) {
      const [prefix, suffix] = pattern.split('*')
      if (
        spec !== pattern &&
        !(pattern.includes('*') && spec.startsWith(prefix) && spec.endsWith(suffix))
      )
        continue
      for (const target of opts.paths[pattern]) {
        const mapped = target.replace(
          '*',
          spec.slice(prefix.length, suffix ? -suffix.length : undefined),
        )
        candidates.push(
          relative(path.posix.resolve(opts.baseUrl ?? opts.pathsBasePath ?? VROOT, mapped)),
        )
      }
    }
    if (spec.startsWith('.')) candidates.push(path.posix.join(path.posix.dirname(from), spec))
    const pkgName = spec.startsWith('@')
      ? spec.split('/').slice(0, 2).join('/')
      : spec.split('/')[0]
    const workspace = packages.get(pkgName)
    if (workspace) {
      const subpath = spec === pkgName ? '.' : './' + spec.slice(pkgName.length + 1)
      const declarations = workspace.pkg.exports ?? {
        '.': workspace.pkg.types ?? workspace.pkg.main,
      }
      for (const [pattern, value] of Object.entries(declarations)) {
        const [prefix, suffix] = pattern.split('*')
        if (
          pattern === subpath ||
          (pattern.includes('*') && subpath.startsWith(prefix) && subpath.endsWith(suffix))
        ) {
          const strings = (v) =>
            typeof v === 'string' ? [v] : Object.values(v ?? {}).flatMap(strings)
          for (const target of strings(value))
            candidates.push(
              path.posix.join(
                workspace.directory,
                target.replace(
                  '*',
                  subpath.slice(prefix.length, suffix ? -suffix.length : undefined),
                ),
              ),
            )
        }
      }
    }
    for (const candidate of candidates)
      for (const ext of [
        '',
        '.ts',
        '.tsx',
        '.js',
        '.mjs',
        '.cjs',
        '.py',
        '/index.ts',
        '/index.tsx',
        '/index.js',
      ]) {
        if (names.has(candidate + ext)) targets.add(candidate + ext)
      }
    const alias = patterns.some(
      (p) =>
        spec === p ||
        (p.includes('*') && spec.startsWith(p.split('*')[0]) && spec.endsWith(p.split('*')[1])),
    )
    const local = /^(?:[./]|file:)/i.test(spec)
    if (!targets.size && (local || alias || workspace))
      errors.push({ file: from, text: `${from}: unresolved internal import ${spec}` })
    return targets
  }
  function add(from, spec, line) {
    for (const target of resolve(from, spec)) edges.get(from).push({ target, line })
  }
  for (const [file, text] of files)
    if (SOURCE.test(file) && !file.endsWith('.py') && category(file) !== 'test') {
      edges.set(file, [])
      const source = ts.createSourceFile(file, blankComments(text), ts.ScriptTarget.Latest, true)
      if (source.parseDiagnostics.length)
        errors.push({ file, text: `${file}: source parse failed` })
      const visit = (node) => {
        const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1
        if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier)
          add(file, node.moduleSpecifier.text, line)
        if (
          ts.isImportEqualsDeclaration(node) &&
          ts.isExternalModuleReference(node.moduleReference) &&
          node.moduleReference.expression
        )
          add(file, node.moduleReference.expression.text, line)
        if (
          ts.isImportTypeNode(node) &&
          ts.isLiteralTypeNode(node.argument) &&
          ts.isStringLiteral(node.argument.literal)
        )
          add(file, node.argument.literal.text, line)
        if (ts.isCallExpression(node)) {
          const call = node.expression.getText(source)
          if (
            call === 'require' ||
            call === 'require.resolve' ||
            node.expression.kind === ts.SyntaxKind.ImportKeyword
          ) {
            const arg = node.arguments[0]
            if (arg && ts.isStringLiteralLike(arg)) add(file, arg.text, line)
            else limitations.push({ file, text: `${file}:${line}: dynamic module loading ${call}` })
          }
          if (
            /(?:^|\.)(?:eval|readFileSync|readFile|exec|execFile|execFileSync|spawn|spawnSync)$/.test(
              call,
            )
          )
            limitations.push({
              file,
              text: `${file}:${line}: filesystem/process/eval access ${call}`,
            })
        }
        ts.forEachChild(node, visit)
      }
      visit(source)
    }
  // Python is parsed with its own grammar. Dynamic importlib/runpy remains explicit.
  const python = [...files].filter(([file]) => file.endsWith('.py') && category(file) !== 'test')
  if (python.length) {
    const parser = `import ast,json,sys
out=[]
for file,text in json.load(sys.stdin):
 try:
  tree=ast.parse(text,filename=file)
  for node in ast.walk(tree):
   if isinstance(node,ast.Import):
    for item in node.names: out.append([file,node.lineno,item.name,0,False])
   elif isinstance(node,ast.ImportFrom):
    if node.module: out.append([file,node.lineno,node.module,node.level,False])
    for item in node.names:
     if item.name!='*': out.append([file,node.lineno,'.'.join(x for x in (node.module,item.name) if x),node.level,'candidate' if node.module else False])
   elif isinstance(node,ast.Call):
    name=ast.unparse(node.func)
    if any(x in name for x in ("import_module","spec_from_file_location","runpy","__import__","exec","open","subprocess")): out.append([file,node.lineno,name,0,True])
 except SyntaxError: out.append([file,0,"SYNTAX_ERROR",0,True])
print(json.dumps(out))`
    for (const [file, line, spec, level, dynamic] of JSON.parse(
      execFileSync('python3', ['-c', parser], {
        input: JSON.stringify(python),
        maxBuffer: 16 * 1024 * 1024,
      }),
    )) {
      if (!edges.has(file)) edges.set(file, [])
      if (spec === 'SYNTAX_ERROR') {
        errors.push({ file, text: `${file}: Python source parse failed` })
        continue
      }
      if (dynamic && dynamic !== 'candidate') {
        limitations.push({ file, text: `${file}:${line}: Python loading/process boundary ${spec}` })
        continue
      }
      let directory = path.posix.dirname(file)
      for (let i = 1; i < level; i++) directory = path.posix.dirname(directory)
      const modulePath = spec.replaceAll('.', '/')
      const candidates = [path.posix.join(directory, modulePath), modulePath]
      const target = candidates
        .flatMap((p) => [p + '.py', p + '/__init__.py'])
        .find((p) => files.has(p))
      if (target) edges.get(file).push({ target, line })
      else if (level && dynamic !== 'candidate')
        errors.push({ file, text: `${file}:${line}: unresolved relative Python import ${spec}` })
    }
  }
  for (const root of edges.keys())
    if (category(root) === 'production') {
      const seen = new Set(),
        queue = [[root, root]]
      while (queue.length) {
        const [file, chain] = queue.shift()
        if (seen.has(file)) continue
        seen.add(file)
        promoted.add(file)
        for (const { target, line } of edges.get(file) ?? []) {
          if (category(target) === 'test')
            errors.push({
              file: root,
              text: `${chain}:${line} -> ${target}: production imports test`,
            })
          else queue.push([target, `${chain}:${line} -> ${target}`])
        }
      }
    }
  const visible = (items) => [
    ...new Set(items.filter((item) => promoted.has(item.file)).map((item) => item.text)),
  ]
  return {
    errors: visible(errors),
    limitations: visible(limitations),
    promoted,
    scanned: edges.size,
  }
}
export function measure(root, base, head) {
  const baseSha = git(root, ['rev-parse', '--verify', base + '^{commit}'])
    .toString()
    .trim()
  const headSha = head
    ? git(root, ['rev-parse', '--verify', head + '^{commit}'])
        .toString()
        .trim()
    : null
  const rows = numstat(
    git(root, [
      'diff',
      '--numstat',
      '-z',
      '--no-ext-diff',
      '--no-renames',
      baseSha,
      ...(headSha ? [headSha] : []),
    ]),
  )
  if (!headSha)
    for (const file of git(root, ['ls-files', '-z', '--others', '--exclude-standard'])
      .toString()
      .split('\0')
      .filter(Boolean)) {
      if (lstatSync(path.join(root, file)).isSymbolicLink())
        throw new Error(`Untracked symlink is unsupported: ${file}`)
      const bytes = readFileSync(path.join(root, file))
      const binary = bytes.subarray(0, 8000).includes(0)
      rows.push({
        file,
        added: binary
          ? null
          : bytes.length
            ? bytes.toString().split('\n').length - (bytes.at(-1) === 10 ? 1 : 0)
            : 0,
        deleted: binary ? null : 0,
      })
    }
  const tree = targetTree(root, headSha)
  const graph = imports(tree.files, tree.names)
  const before = targetTree(root, baseSha)
  const prior = imports(before.files, before.names)
  const totals = { production: 0, test: 0, documentation: 0, binaryFiles: 0 }
  for (const row of rows) {
    row.category =
      category(row.file) === 'test'
        ? 'test'
        : graph.promoted.has(row.file) || prior.promoted.has(row.file)
          ? 'production'
          : category(row.file)
    if (row.added === null) totals.binaryFiles++
    else totals[row.category] += row.added + row.deleted
  }
  return {
    base: baseSha,
    head: headSha ?? 'WORKTREE+INDEX+UNTRACKED',
    totals,
    files: rows,
    scanned: graph.scanned,
    errors: graph.errors,
    limitations: graph.limitations,
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    if (process.argv.includes('--self-test')) {
      const result = kanariefåglar()
      if (result.length) throw new Error(JSON.stringify(result))
      console.warn(
        'Shared source-scan canaries passed; run node --test scripts/production-lines.test.mjs for counter tests.',
      )
    } else {
      const args = process.argv.slice(2)
      if (!args.length || args.length > 2)
        throw new Error('Usage: node scripts/production-lines.mjs BASE [HEAD]')
      const root = git(path.dirname(fileURLToPath(import.meta.url)), [
        'rev-parse',
        '--show-toplevel',
      ])
        .toString()
        .trim()
      const report = measure(root, args[0], args[1])
      process.stdout.write(JSON.stringify(report, null, 2) + '\n')
      if (report.errors.length) process.exitCode = 1
    }
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
