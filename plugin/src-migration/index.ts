import fs from 'node:fs'
import path from 'node:path'
import { builtinModules } from 'node:module'
import type { AddressInfo } from 'node:net'
import {
  type ConfigEnv,
  type Plugin,
  type UserConfig,
  type UserConfigFn,
  type UserConfigExport,
  mergeConfig,
} from 'vite'


function isESModule(packageJson: Record<string, any> = {}) {
  return packageJson.type === 'module'
}

async function getPackageJson(root: string): Promise<Record<string, any> | undefined> {
  const packageJsonPath = path.join(root, 'package.json')
  if (fs.existsSync(packageJsonPath)) {
    try {
      const json = JSON.parse(await fs.promises.readFile(packageJsonPath, 'utf8'))
      return json
    } catch { }
  }
}

// ------- vite.base.config.ts ------- S
// @see - https://github.com/electron/forge/blob/v7.3.0/packages/template/vite-typescript/tmpl/vite.base.config.ts

async function getExternal(packageJson: Record<string, any> = {}) {
  const builtins = ['electron', ...builtinModules.map((m) => [m, `node:${m}`]).flat()]
  return [...builtins, ...Object.keys(packageJson.dependencies)]
}

function getBuildConfig(env: ConfigEnv<'build'>): UserConfig {
  const { root, mode, command } = env

  return {
    root,
    mode,
    build: {
      // Prevent multiple builds from interfering with each other.
      emptyOutDir: false,
      // 🚧 Multiple builds may conflict.
      outDir: '.vite/build',
      watch: command === 'serve' ? {} : null,
      minify: command === 'build',
      sourcemap: command === 'serve',
    },
    clearScreen: false,
  }
}

function getDefineKeys(names: string[]) {
  const define: { [name: string]: VitePluginRuntimeKeys } = {}

  return names.reduce((acc, name) => {
    const NAME = name.toUpperCase()
    const keys: VitePluginRuntimeKeys = {
      VITE_DEV_SERVER_URL: `${NAME}_VITE_DEV_SERVER_URL`,
      VITE_NAME: `${NAME}_VITE_NAME`,
    }

    return { ...acc, [name]: keys }
  }, define)
}

function getBuildDefine(env: ConfigEnv<'build'>) {
  const { command, forgeConfig } = env
  const names = forgeConfig.renderer.filter(({ name }) => name != null).map(({ name }) => name!)
  const defineKeys = getDefineKeys(names)
  const define = Object.entries(defineKeys).reduce((acc, [name, keys]) => {
    const { VITE_DEV_SERVER_URL, VITE_NAME } = keys
    const def = {
      [VITE_DEV_SERVER_URL]: command === 'serve' ? JSON.stringify(process.env[VITE_DEV_SERVER_URL]) : undefined,
      [VITE_NAME]: JSON.stringify(name),
    }
    return { ...acc, ...def }
  }, {} as Record<string, any>)

  return define
}

function pluginExposeRenderer(name: string): Plugin {
  const { VITE_DEV_SERVER_URL } = getDefineKeys([name])[name]

  return {
    name: '@electron-forge/plugin-vite:expose-renderer',
    configureServer(server) {
      process.viteDevServers ??= {}
      // Expose server for preload scripts hot reload.
      process.viteDevServers[name] = server

      server.httpServer?.once('listening', () => {
        const addressInfo = server.httpServer!.address() as AddressInfo
        // Expose env constant for main process use.
        process.env[VITE_DEV_SERVER_URL] = `http://localhost:${addressInfo?.port}`
      })
    },
  }
}

function pluginHotRestart(command: 'reload' | 'restart'): Plugin {
  return {
    name: '@electron-forge/plugin-vite:hot-restart',
    closeBundle() {
      if (command === 'reload') {
        for (const server of Object.values(process.viteDevServers)) {
          // Preload scripts hot reload.
          (server.hot || server.ws).send({ type: 'full-reload' })
        }
      } else {
        // Main process hot restart.
        // https://github.com/electron/forge/blob/v7.2.0/packages/api/core/src/api/start.ts#L216-L223
        process.stdin.emit('data', 'rs')
      }
    },
  }
}

// ------- vite.base.config.ts ------- E


// ------- vite.main.config.ts ------- S
// @see - https://github.com/electron/forge/blob/v7.3.0/packages/template/vite-typescript/tmpl/vite.main.config.ts

function main(viteConfig: UserConfigExport): UserConfigFn {
  return async function _main(env): Promise<UserConfig> {
    const forgeEnv = env as ConfigEnv<'build'>
    const { forgeConfigSelf, root } = forgeEnv
    const define = getBuildDefine(forgeEnv)
    const packageJson = await getPackageJson(root)
    const external = await getExternal(packageJson)
    const esmodule = isESModule(packageJson)
    const config: UserConfig = {
      build: {
        lib: {
          entry: forgeConfigSelf.entry!,
          fileName: () => '[name].js',
          formats: [esmodule ? 'es' : 'cjs'],
        },
        rollupOptions: {
          external,
        },
      },
      plugins: [pluginHotRestart('restart')],
      define,
      resolve: {
        // Load the Node.js entry.
        conditions: ['node'],
        mainFields: ['module', 'jsnext:main', 'jsnext'],
      },
    }

    const forgeViteConfig = mergeConfig(getBuildConfig(forgeEnv), config)
    const userConfig = await (typeof viteConfig === 'function' ? viteConfig(forgeEnv) : viteConfig)
    return mergeConfig(forgeViteConfig, userConfig)
  }
}

// ------- vite.main.config.ts ------- E


// ------- vite.renderer.config.ts ------- S
// @see - https://github.com/electron/forge/blob/v7.3.0/packages/template/vite-typescript/tmpl/vite.renderer.config.ts

function renderer(viteConfig: UserConfigExport): UserConfigFn {
  return async function _renderer(env): Promise<UserConfig> {
    const forgeEnv = env as ConfigEnv<'renderer'>
    const { root, mode, forgeConfigSelf } = forgeEnv
    const name = forgeConfigSelf.name ?? ''
    const conig: UserConfig = {
      root,
      mode,
      base: './',
      build: {
        outDir: `.vite/renderer/${name}`,
      },
      plugins: [pluginExposeRenderer(name)],
      resolve: {
        preserveSymlinks: true,
      },
      clearScreen: false,
    }

    const userConfig = await (typeof viteConfig === 'function' ? viteConfig(forgeEnv) : viteConfig)
    return mergeConfig(conig, userConfig)
  }
}

// ------- vite.renderer.config.ts ------- E


// ------- vite.preload.config.ts ------- S
// @see - https://github.com/electron/forge/blob/v7.3.0/packages/template/vite-typescript/tmpl/vite.preload.config.ts

function preload(viteConfig: UserConfigExport): UserConfigFn {
  return async function _preload(env): Promise<UserConfig> {
    const forgeEnv = env as ConfigEnv<'build'>
    const { forgeConfigSelf, root } = forgeEnv
    const packageJson = await getPackageJson(root)
    const external = await getExternal(packageJson)
    const esmodule = isESModule(packageJson)
    const ext = esmodule ? 'mjs' : 'js'
    const config: UserConfig = {
      build: {
        rollupOptions: {
          external,
          // Preload scripts may contain Web assets, so use the `build.rollupOptions.input` instead `build.lib.entry`.
          input: forgeConfigSelf.entry!,
          output: {
            // https://github.com/electron-vite/vite-plugin-electron/blob/v0.28.5/README.md#built-format
            // https://github.com/electron-vite/vite-plugin-electron/blob/v0.28.5/src/simple.ts#L56-L82
            format: 'cjs',
            // It should not be split chunks.
            inlineDynamicImports: true,
            entryFileNames: `[name].${ext}`,
            chunkFileNames: `[name].${ext}`,
            assetFileNames: '[name].[ext]',
          },
        },
      },
      plugins: [pluginHotRestart('reload')],
    }

    const forgeViteConfig = mergeConfig(getBuildConfig(forgeEnv), config)
    const userConfig = await (typeof viteConfig === 'function' ? viteConfig(forgeEnv) : viteConfig)
    return mergeConfig(forgeViteConfig, userConfig)
  }
}

// ------- vite.preload.config.ts ------- E

export const forgeViteConfig = {
  main,
  renderer,
  preload,
}
