const fs = require('fs')
const path = require('path')
const dotenv = require('dotenv')
const childProcess = require('child_process')

const ENCODING = 'utf8'
const TYPE_ENV = 'env'
const TYPE_ENV_FILE = 'envFile'
const TYPE_ENV_VAULT_FILE = 'envVaultFile'
const DEFAULT_ENVS = [{ type: TYPE_ENV_FILE, value: '.env' }]
const DEFAULT_ENV_VAULTS = [{ type: TYPE_ENV_VAULT_FILE, value: '.env.vault' }]

const inject = require('./../helpers/inject')
const decrypt = require('./../helpers/decrypt')
const parseDecryptEvalExpand = require('./../helpers/parseDecryptEvalExpand')
const parseEnvironmentFromDotenvKey = require('./../helpers/parseEnvironmentFromDotenvKey')
const guessPrivateKeyFilename = require('./../helpers/guessPrivateKeyFilename')
const guessPrivateKeyName = require('./../helpers/guessPrivateKeyName')
const detectEncoding = require('./../helpers/detectEncoding')

const Keypair = require('./../services/keypair')

class Run {
  constructor (envs = [], overload = false, DOTENV_KEY = '', processEnv = process.env) {
    this.dotenvPrivateKeyNames = Object.keys(processEnv).filter(key => key.startsWith('DOTENV_PRIVATE_KEY')) // important, must be first. used by determineEnvs
    this.envs = this._determineEnvs(envs, DOTENV_KEY)
    this.overload = overload
    this.DOTENV_KEY = DOTENV_KEY
    this.processEnv = processEnv

    this.processedEnvs = []
    this.readableFilepaths = new Set()
    this.readableStrings = new Set()
    this.uniqueInjectedKeys = new Set()
  }

  run () {
    // example
    // envs [
    //   { type: 'envVaultFile', value: '.env.vault' },
    //   { type: 'env', value: 'HELLO=one' },
    //   { type: 'envFile', value: '.env' },
    //   { type: 'env', value: 'HELLO=three' }
    // ]

    for (const env of this.envs) {
      if (env.type === TYPE_ENV_VAULT_FILE) {
        this._injectEnvVaultFile(env.value)
      } else if (env.type === TYPE_ENV_FILE) {
        this._injectEnvFile(env.value)
      } else if (env.type === TYPE_ENV) {
        this._injectEnv(env.value)
      }
    }

    return {
      processedEnvs: this.processedEnvs,
      readableStrings: [...this.readableStrings],
      readableFilepaths: [...this.readableFilepaths],
      uniqueInjectedKeys: [...this.uniqueInjectedKeys]
    }
  }

  _injectEnv (env) {
    const row = {}
    row.type = TYPE_ENV
    row.string = env

    try {
      const { parsed, processEnv, warnings } = parseDecryptEvalExpand(env, null, this.processEnv)
      row.parsed = parsed
      row.warnings = warnings
      this.readableStrings.add(env)

      const { injected, preExisted } = this._inject(processEnv, parsed, this.overload, this.processEnv)
      row.injected = injected
      row.preExisted = preExisted

      for (const key of Object.keys(injected)) {
        this.uniqueInjectedKeys.add(key) // track uniqueInjectedKeys across multiple files
      }
    } catch (e) {
      row.error = e
    }

    this.processedEnvs.push(row)
  }

  _injectEnvFile (envFilepath) {
    const row = {}
    row.type = TYPE_ENV_FILE
    row.filepath = envFilepath

    const filepath = path.resolve(envFilepath)
    try {
      const encoding = detectEncoding(filepath)
      const src = fs.readFileSync(filepath, { encoding })
      this.readableFilepaths.add(envFilepath)

      const privateKey = this._determinePrivateKey(envFilepath)
      const { parsed, processEnv, warnings } = parseDecryptEvalExpand(src, privateKey, this.processEnv)
      row.parsed = parsed
      row.warnings = warnings

      const { injected, preExisted } = this._inject(processEnv, parsed, this.overload, this.processEnv)
      row.injected = injected
      row.preExisted = preExisted

      for (const key of Object.keys(injected)) {
        this.uniqueInjectedKeys.add(key) // track uniqueInjectedKeys across multiple files
      }
    } catch (e) {
      if (e.code === 'ENOENT') {
        const error = new Error(`missing ${envFilepath} file (${filepath})`)
        error.code = 'MISSING_ENV_FILE'

        row.error = error
      } else {
        row.error = e
      }
    }

    this.processedEnvs.push(row)
  }

  _injectEnvVaultFile (envVaultFilepath) {
    const row = {}
    row.type = TYPE_ENV_VAULT_FILE
    row.filepath = envVaultFilepath

    const filepath = path.resolve(envVaultFilepath)
    this.readableFilepaths.add(envVaultFilepath)

    if (!fs.existsSync(filepath)) {
      const code = 'MISSING_ENV_VAULT_FILE'
      const message = `you set DOTENV_KEY but your .env.vault file is missing: ${filepath}`
      const error = new Error(message)
      error.code = code
      throw error
    }

    if (this.DOTENV_KEY.length < 1) {
      const code = 'MISSING_DOTENV_KEY'
      const message = `your DOTENV_KEY appears to be blank: '${this.DOTENV_KEY}'`
      const error = new Error(message)
      error.code = code
      throw error
    }

    let decrypted
    const dotenvKeys = this._dotenvKeys()
    const parsedVault = this._parsedVault(filepath)
    for (let i = 0; i < dotenvKeys.length; i++) {
      try {
        const dotenvKey = dotenvKeys[i].trim() // dotenv://key_1234@...?environment=prod

        decrypted = this._decrypted(dotenvKey, parsedVault)

        break
      } catch (error) {
        // last key
        if (i + 1 >= dotenvKeys.length) {
          throw error
        }
        // try next key
      }
    }

    try {
      // parse this. it's the equivalent of the .env file
      const { parsed, processEnv, warnings } = parseDecryptEvalExpand(decrypted, null, this.processEnv)
      row.parsed = parsed
      row.warnings = warnings

      const { injected, preExisted } = this._inject(processEnv, parsed, this.overload, this.processEnv)
      row.injected = injected
      row.preExisted = preExisted

      for (const key of Object.keys(injected)) {
        this.uniqueInjectedKeys.add(key) // track uniqueInjectedKeys across multiple files
      }
    } catch (e) {
      row.error = e
    }

    this.processedEnvs.push(row)
  }

  _inject (clonedProcessEnv, parsed, overload, processEnv) {
    return inject(clonedProcessEnv, parsed, overload, processEnv)
  }

  _determineEnvsFromDotenvPrivateKey () {
    const envs = []

    for (const privateKeyName of this.dotenvPrivateKeyNames) {
      const filename = guessPrivateKeyFilename(privateKeyName)
      envs.push({ type: TYPE_ENV_FILE, value: filename })
    }

    return envs
  }

  _determineEnvs (envs = [], DOTENV_KEY = '') {
    if (!envs || envs.length <= 0) {
      // if process.env.DOTENV_PRIVATE_KEY or process.env.DOTENV_PRIVATE_KEY_${environment} is set, assume inline encryption methodology
      if (this.dotenvPrivateKeyNames.length > 0) {
        return this._determineEnvsFromDotenvPrivateKey()
      }

      if (DOTENV_KEY.length > 0) {
        // if DOTENV_KEY is set then default to look for .env.vault file
        return DEFAULT_ENV_VAULTS
      } else {
        return DEFAULT_ENVS // default to .env file expectation
      }
    } else {
      let fileAlreadySpecified = false // can be .env or .env.vault type

      for (const env of envs) {
        // if DOTENV_KEY set then we are checking if a .env.vault file is already specified
        if (DOTENV_KEY.length > 0 && env.type === TYPE_ENV_VAULT_FILE) {
          fileAlreadySpecified = true
        }

        // if DOTENV_KEY not set then we are checking if a .env file is already specified
        if (DOTENV_KEY.length <= 0 && env.type === TYPE_ENV_FILE) {
          fileAlreadySpecified = true
        }
      }

      // return early since envs array objects already contain 1 .env.vault or .env file
      if (fileAlreadySpecified) {
        return envs
      }

      // no .env.vault or .env file specified as a flag so we assume either .env.vault (if dotenv key is set) or a .env file
      if (DOTENV_KEY.length > 0) {
        // if DOTENV_KEY is set then default to look for .env.vault file
        return [...DEFAULT_ENV_VAULTS, ...envs]
      } else {
        // if no DOTENV_KEY then default to look for .env file
        return [...DEFAULT_ENVS, ...envs]
      }
    }
  }

  // handle scenario for comma separated keys - for use with key rotation
  // example: DOTENV_KEY="dotenv://:key_1234@dotenvx.com/vault/.env.vault?environment=prod,dotenv://:key_7890@dotenvx.com/vault/.env.vault?environment=prod"
  _dotenvKeys () {
    return this.DOTENV_KEY.split(',')
  }

  // { "DOTENV_VAULT_DEVELOPMENT": "<ciphertext>" }
  _parsedVault (filepath) {
    const src = fs.readFileSync(filepath, { encoding: ENCODING })
    return dotenv.parse(src)
  }

  _decrypted (dotenvKey, parsedVault) {
    const environment = parseEnvironmentFromDotenvKey(dotenvKey)

    // DOTENV_KEY_PRODUCTION
    const environmentKey = `DOTENV_VAULT_${environment.toUpperCase()}`
    const ciphertext = parsedVault[environmentKey]
    if (!ciphertext) {
      const error = new Error(`NOT_FOUND_DOTENV_ENVIRONMENT: cannot locate environment ${environmentKey} in your .env.vault file`)
      error.code = 'NOT_FOUND_DOTENV_ENVIRONMENT'

      throw error
    }

    return decrypt(ciphertext, dotenvKey)
  }

  _determinePrivateKey (envFilepath) {
    const privateKeyName = guessPrivateKeyName(envFilepath)

    let privateKey
    try {
      // if installed as sibling module
      const projectRoot = path.resolve(process.cwd())
      const dotenvxProPath = require.resolve('@dotenvx/dotenvx-pro', { paths: [projectRoot] })
      const { keypair } = require(dotenvxProPath)
      privateKey = keypair(envFilepath, privateKeyName)
    } catch (_e) {
      try {
        // if installed as binary cli
        privateKey = childProcess.execSync(`dotenvx-pro keypair ${privateKeyName} -f ${envFilepath}`, { stdio: ['pipe', 'pipe', 'ignore'] }).toString().trim()
      } catch (_e) {
        // fallback to local KeyPair - smart enough to handle process.env, .env.keys, etc
        privateKey = new Keypair(envFilepath, privateKeyName).run()
      }
    }

    return privateKey
  }
}

module.exports = Run
