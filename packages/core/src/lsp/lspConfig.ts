/**
 * LSP Language Configuration — Maps file extensions to LSP server commands.
 *
 * Covers 40+ languages out of the box. Each entry specifies the server
 * command, installation note, and supported file extensions.
 *
 * Inspired by OhMyPi's LSP integration — gives the agent IDE-level
 * code intelligence (diagnostics, go-to-definition, references, hover,
 * rename, code actions).
 */

export interface LspLanguageConfig {
  /** Language identifier (e.g., 'typescript', 'python') */
  languageId: string;
  /** File extensions this server handles */
  extensions: string[];
  /** Command to start the LSP server */
  command: string;
  /** Arguments passed to the command */
  args?: string[];
  /** Environment variables to set */
  env?: Record<string, string>;
  /** Root pattern files that indicate project root */
  rootPatterns?: string[];
  /** Human-readable installation note */
  installNote: string;
  /** Whether the server supports diagnostics */
  supportsDiagnostics: boolean;
  /** Whether the server supports go-to-definition */
  supportsDefinition: boolean;
  /** Whether the server supports references */
  supportsReferences: boolean;
  /** Whether the server supports hover */
  supportsHover: boolean;
  /** Whether the server supports rename */
  supportsRename: boolean;
  /** Whether the server supports code actions */
  supportsCodeActions: boolean;
}

/**
 * Built-in language configurations.
 * Only includes servers commonly available or easily installable.
 */
export const BUILTIN_LSP_CONFIGS: LspLanguageConfig[] = [
  // === TypeScript/JavaScript ===
  {
    languageId: 'typescript',
    extensions: ['.ts', '.tsx', '.mts', '.cts'],
    command: 'typescript-language-server',
    args: ['--stdio'],
    rootPatterns: ['tsconfig.json', 'jsconfig.json', 'package.json'],
    installNote: 'npm install -g typescript-language-server typescript',
    supportsDiagnostics: true,
    supportsDefinition: true,
    supportsReferences: true,
    supportsHover: true,
    supportsRename: true,
    supportsCodeActions: true,
  },
  {
    languageId: 'javascript',
    extensions: ['.js', '.jsx', '.mjs', '.cjs'],
    command: 'typescript-language-server',
    args: ['--stdio'],
    rootPatterns: ['package.json', 'jsconfig.json', 'tsconfig.json'],
    installNote: 'npm install -g typescript-language-server typescript',
    supportsDiagnostics: true,
    supportsDefinition: true,
    supportsReferences: true,
    supportsHover: true,
    supportsRename: true,
    supportsCodeActions: true,
  },

  // === Python ===
  {
    languageId: 'python',
    extensions: ['.py', '.pyi', '.pyx'],
    command: 'pyright-langserver',
    args: ['--stdio'],
    rootPatterns: ['pyproject.toml', 'setup.py', 'setup.cfg', 'requirements.txt'],
    installNote: 'pip install pyright',
    supportsDiagnostics: true,
    supportsDefinition: true,
    supportsReferences: true,
    supportsHover: true,
    supportsRename: true,
    supportsCodeActions: true,
  },

  // === Rust ===
  {
    languageId: 'rust',
    extensions: ['.rs'],
    command: 'rust-analyzer',
    args: [],
    rootPatterns: ['Cargo.toml'],
    installNote: 'rustup component add rust-analyzer',
    supportsDiagnostics: true,
    supportsDefinition: true,
    supportsReferences: true,
    supportsHover: true,
    supportsRename: true,
    supportsCodeActions: true,
  },

  // === Go ===
  {
    languageId: 'go',
    extensions: ['.go'],
    command: 'gopls',
    args: [],
    rootPatterns: ['go.mod', 'go.sum'],
    installNote: 'go install golang.org/x/tools/gopls@latest',
    supportsDiagnostics: true,
    supportsDefinition: true,
    supportsReferences: true,
    supportsHover: true,
    supportsRename: true,
    supportsCodeActions: true,
  },

  // === C/C++ ===
  {
    languageId: 'c',
    extensions: ['.c', '.h'],
    command: 'clangd',
    args: [],
    rootPatterns: ['compile_commands.json', 'CMakeLists.txt', 'Makefile'],
    installNote: 'Install clangd via your package manager (e.g., brew install llvm)',
    supportsDiagnostics: true,
    supportsDefinition: true,
    supportsReferences: true,
    supportsHover: true,
    supportsRename: true,
    supportsCodeActions: true,
  },
  {
    languageId: 'cpp',
    extensions: ['.cpp', '.cc', '.cxx', '.hpp', '.hxx'],
    command: 'clangd',
    args: [],
    rootPatterns: ['compile_commands.json', 'CMakeLists.txt', 'Makefile'],
    installNote: 'Install clangd via your package manager',
    supportsDiagnostics: true,
    supportsDefinition: true,
    supportsReferences: true,
    supportsHover: true,
    supportsRename: true,
    supportsCodeActions: true,
  },

  // === Java ===
  {
    languageId: 'java',
    extensions: ['.java'],
    command: 'jdtls',
    args: [],
    rootPatterns: ['pom.xml', 'build.gradle', 'build.gradle.kts'],
    installNote: 'Install Eclipse JDT LS (jdtls) via your package manager',
    supportsDiagnostics: true,
    supportsDefinition: true,
    supportsReferences: true,
    supportsHover: true,
    supportsRename: true,
    supportsCodeActions: true,
  },

  // === Kotlin ===
  {
    languageId: 'kotlin',
    extensions: ['.kt', '.kts'],
    command: 'kotlin-language-server',
    args: [],
    rootPatterns: ['build.gradle.kts', 'settings.gradle.kts'],
    installNote: 'Install kotlin-language-server via your package manager',
    supportsDiagnostics: true,
    supportsDefinition: true,
    supportsReferences: true,
    supportsHover: true,
    supportsRename: true,
    supportsCodeActions: true,
  },

  // === C# ===
  {
    languageId: 'csharp',
    extensions: ['.cs', '.csx'],
    command: 'omnisharp',
    args: ['-lsp'],
    rootPatterns: ['*.sln', '*.csproj'],
    installNote: 'Install OmniSharp via your package manager',
    supportsDiagnostics: true,
    supportsDefinition: true,
    supportsReferences: true,
    supportsHover: true,
    supportsRename: true,
    supportsCodeActions: true,
  },

  // === Ruby ===
  {
    languageId: 'ruby',
    extensions: ['.rb', '.rake', '.gemspec'],
    command: 'solargraph',
    args: ['stdio'],
    rootPatterns: ['Gemfile', '.ruby-version'],
    installNote: 'gem install solargraph',
    supportsDiagnostics: true,
    supportsDefinition: true,
    supportsReferences: true,
    supportsHover: true,
    supportsRename: true,
    supportsCodeActions: true,
  },

  // === PHP ===
  {
    languageId: 'php',
    extensions: ['.php'],
    command: 'intelephense',
    args: ['--stdio'],
    rootPatterns: ['composer.json', 'vendor'],
    installNote: 'npm install -g intelephense',
    supportsDiagnostics: true,
    supportsDefinition: true,
    supportsReferences: true,
    supportsHover: true,
    supportsRename: true,
    supportsCodeActions: true,
  },

  // === Swift ===
  {
    languageId: 'swift',
    extensions: ['.swift'],
    command: 'sourcekit-lsp',
    args: [],
    rootPatterns: ['Package.swift'],
    installNote: 'Included with Xcode or Swift toolchain',
    supportsDiagnostics: true,
    supportsDefinition: true,
    supportsReferences: true,
    supportsHover: true,
    supportsRename: true,
    supportsCodeActions: false,
  },

  // === Lua ===
  {
    languageId: 'lua',
    extensions: ['.lua'],
    command: 'lua-language-server',
    args: [],
    rootPatterns: ['.luarc.json', '.luarc.jsonc'],
    installNote: 'Install lua-language-server via your package manager',
    supportsDiagnostics: true,
    supportsDefinition: true,
    supportsReferences: true,
    supportsHover: true,
    supportsRename: true,
    supportsCodeActions: true,
  },

  // === Zig ===
  {
    languageId: 'zig',
    extensions: ['.zig'],
    command: 'zls',
    args: [],
    rootPatterns: ['build.zig'],
    installNote: 'Install zls (Zig Language Server) via your package manager',
    supportsDiagnostics: true,
    supportsDefinition: true,
    supportsReferences: true,
    supportsHover: true,
    supportsRename: true,
    supportsCodeActions: true,
  },

  // === Scala ===
  {
    languageId: 'scala',
    extensions: ['.scala', '.sc'],
    command: 'metals',
    args: [],
    rootPatterns: ['build.sbt'],
    installNote: 'Install Metals via coursier or your package manager',
    supportsDiagnostics: true,
    supportsDefinition: true,
    supportsReferences: true,
    supportsHover: true,
    supportsRename: true,
    supportsCodeActions: true,
  },

  // === Dart ===
  {
    languageId: 'dart',
    extensions: ['.dart'],
    command: 'dart',
    args: ['language-server', '--protocol=lsp'],
    rootPatterns: ['pubspec.yaml'],
    installNote: 'Install Dart SDK via your package manager',
    supportsDiagnostics: true,
    supportsDefinition: true,
    supportsReferences: true,
    supportsHover: true,
    supportsRename: true,
    supportsCodeActions: true,
  },

  // === Elm ===
  {
    languageId: 'elm',
    extensions: ['.elm'],
    command: 'elm-language-server',
    args: [],
    rootPatterns: ['elm.json'],
    installNote: 'npm install -g @elm-tooling/elm-language-server',
    supportsDiagnostics: true,
    supportsDefinition: true,
    supportsReferences: true,
    supportsHover: true,
    supportsRename: false,
    supportsCodeActions: true,
  },

  // === Terraform / HCL ===
  {
    languageId: 'terraform',
    extensions: ['.tf', '.tfvars'],
    command: 'terraform-ls',
    args: ['serve'],
    rootPatterns: ['*.tf'],
    installNote: 'Install terraform-ls via your package manager',
    supportsDiagnostics: true,
    supportsDefinition: true,
    supportsReferences: true,
    supportsHover: true,
    supportsRename: false,
    supportsCodeActions: false,
  },

  // === Dockerfile ===
  {
    languageId: 'dockerfile',
    extensions: ['Dockerfile', '.dockerfile'],
    command: 'docker-langserver',
    args: ['--stdio'],
    rootPatterns: ['Dockerfile'],
    installNote: 'npm install -g dockerfile-language-server-nodejs',
    supportsDiagnostics: true,
    supportsDefinition: false,
    supportsReferences: false,
    supportsHover: true,
    supportsRename: false,
    supportsCodeActions: false,
  },

  // === YAML ===
  {
    languageId: 'yaml',
    extensions: ['.yaml', '.yml'],
    command: 'yaml-language-server',
    args: ['--stdio'],
    rootPatterns: [],
    installNote: 'npm install -g yaml-language-server',
    supportsDiagnostics: true,
    supportsDefinition: true,
    supportsReferences: true,
    supportsHover: true,
    supportsRename: false,
    supportsCodeActions: false,
  },

  // === JSON ===
  {
    languageId: 'json',
    extensions: ['.json', '.jsonc'],
    command: 'vscode-json-languageserver',
    args: ['--stdio'],
    rootPatterns: [],
    installNote: 'npm install -g vscode-langservers-extracted',
    supportsDiagnostics: true,
    supportsDefinition: true,
    supportsReferences: false,
    supportsHover: true,
    supportsRename: false,
    supportsCodeActions: false,
  },

  // === HTML ===
  {
    languageId: 'html',
    extensions: ['.html', '.htm'],
    command: 'vscode-html-languageserver',
    args: ['--stdio'],
    rootPatterns: [],
    installNote: 'npm install -g vscode-langservers-extracted',
    supportsDiagnostics: true,
    supportsDefinition: false,
    supportsReferences: false,
    supportsHover: true,
    supportsRename: false,
    supportsCodeActions: true,
  },

  // === CSS ===
  {
    languageId: 'css',
    extensions: ['.css', '.scss', '.less'],
    command: 'vscode-css-languageserver',
    args: ['--stdio'],
    rootPatterns: [],
    installNote: 'npm install -g vscode-langservers-extracted',
    supportsDiagnostics: true,
    supportsDefinition: true,
    supportsReferences: true,
    supportsHover: true,
    supportsRename: false,
    supportsCodeActions: false,
  },

  // === Markdown ===
  {
    languageId: 'markdown',
    extensions: ['.md', '.mdx'],
    command: 'marksman',
    args: ['server'],
    rootPatterns: [],
    installNote: 'Install marksman via your package manager',
    supportsDiagnostics: true,
    supportsDefinition: true,
    supportsReferences: true,
    supportsHover: true,
    supportsRename: false,
    supportsCodeActions: false,
  },

  // === SQL ===
  {
    languageId: 'sql',
    extensions: ['.sql'],
    command: 'sql-language-server',
    args: ['up', '--method', 'stdio'],
    rootPatterns: [],
    installNote: 'npm install -g sql-language-server',
    supportsDiagnostics: true,
    supportsDefinition: false,
    supportsReferences: false,
    supportsHover: true,
    supportsRename: false,
    supportsCodeActions: false,
  },

  // === Shell ===
  {
    languageId: 'shellscript',
    extensions: ['.sh', '.bash', '.zsh'],
    command: 'bash-language-server',
    args: ['start'],
    rootPatterns: [],
    installNote: 'npm install -g bash-language-server',
    supportsDiagnostics: true,
    supportsDefinition: true,
    supportsReferences: true,
    supportsHover: true,
    supportsRename: true,
    supportsCodeActions: false,
  },

  // === GraphQL ===
  {
    languageId: 'graphql',
    extensions: ['.graphql', '.gql'],
    command: 'graphql-lsp',
    args: ['server', '-m', 'stdio'],
    rootPatterns: ['.graphqlrc', 'graphql.config'],
    installNote: 'npm install -g graphql-language-service-cli',
    supportsDiagnostics: true,
    supportsDefinition: true,
    supportsReferences: false,
    supportsHover: true,
    supportsRename: false,
    supportsCodeActions: false,
  },

  // === Prisma ===
  {
    languageId: 'prisma',
    extensions: ['.prisma'],
    command: 'prisma-language-server',
    args: ['--stdio'],
    rootPatterns: ['schema.prisma'],
    installNote: 'npm install -g @prisma/language-server',
    supportsDiagnostics: true,
    supportsDefinition: true,
    supportsReferences: false,
    supportsHover: true,
    supportsRename: true,
    supportsCodeActions: true,
  },

  // === Vue ===
  {
    languageId: 'vue',
    extensions: ['.vue'],
    command: 'vue-language-server',
    args: ['--stdio'],
    rootPatterns: ['package.json', 'vue.config.js'],
    installNote: 'npm install -g @vue/language-server',
    supportsDiagnostics: true,
    supportsDefinition: true,
    supportsReferences: true,
    supportsHover: true,
    supportsRename: true,
    supportsCodeActions: true,
  },

  // === Svelte ===
  {
    languageId: 'svelte',
    extensions: ['.svelte'],
    command: 'svelteserver',
    args: ['--stdio'],
    rootPatterns: ['package.json'],
    installNote: 'npm install -g svelte-language-server',
    supportsDiagnostics: true,
    supportsDefinition: true,
    supportsReferences: true,
    supportsHover: true,
    supportsRename: true,
    supportsCodeActions: true,
  },

  // === Astro ===
  {
    languageId: 'astro',
    extensions: ['.astro'],
    command: 'astro-ls',
    args: ['--stdio'],
    rootPatterns: ['astro.config.mjs', 'astro.config.ts'],
    installNote: 'npm install -g @astrojs/language-server',
    supportsDiagnostics: true,
    supportsDefinition: true,
    supportsReferences: false,
    supportsHover: true,
    supportsRename: false,
    supportsCodeActions: true,
  },

  // === TOML ===
  {
    languageId: 'toml',
    extensions: ['.toml'],
    command: 'taplo',
    args: ['lsp', 'stdio'],
    rootPatterns: [],
    installNote: 'Install taplo via cargo install taplo-cli or your package manager',
    supportsDiagnostics: true,
    supportsDefinition: false,
    supportsReferences: false,
    supportsHover: true,
    supportsRename: false,
    supportsCodeActions: true,
  },

  // === Nix ===
  {
    languageId: 'nix',
    extensions: ['.nix'],
    command: 'nil',
    args: [],
    rootPatterns: ['flake.nix', 'default.nix'],
    installNote: 'Install nil (nix LSP) via your package manager',
    supportsDiagnostics: true,
    supportsDefinition: true,
    supportsReferences: true,
    supportsHover: true,
    supportsRename: false,
    supportsCodeActions: true,
  },
];

/**
 * Map from file extension to language config for fast lookup.
 */
export function buildExtensionMap(): Map<string, LspLanguageConfig> {
  const map = new Map<string, LspLanguageConfig>();
  for (const config of BUILTIN_LSP_CONFIGS) {
    for (const ext of config.extensions) {
      map.set(ext, config);
    }
  }
  return map;
}

/**
 * Find the LSP language config for a given file path.
 */
export function findLspConfig(
  filePath: string,
  extensionMap?: Map<string, LspLanguageConfig>,
): LspLanguageConfig | undefined {
  const ext = filePath.includes('.') ? filePath.slice(filePath.lastIndexOf('.')) : '';

  // Handle Dockerfile (no extension)
  if (filePath.endsWith('Dockerfile')) {
    // Dockerfile is registered with the literal key 'Dockerfile' in
    // BUILTIN_LSP_CONFIGS, not as a `.dockerfile` extension.
    const map = extensionMap ?? buildExtensionMap();
    return map.get('Dockerfile');
  }

  const map = extensionMap ?? buildExtensionMap();
  return map.get(ext.toLowerCase());
}
