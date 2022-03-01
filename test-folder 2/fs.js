/* exported GitFileSystemClass, GFS, ENV, DeviceFileSystemClass, PathUtils, ObservableClass */

class ExtError extends Error {
  constructor(args) {
    super(args.message)
    Object.assign(this, args)
    this.name = this.code
  }
}

const ERROR_SOURCE = 'filesystem'
const isIDB = path => path === 'idb' || path.startsWith('idb/')

const ext = (path) => {
  if (path === null) return null
  const tail = basename(path)
  const index = tail.lastIndexOf('.')
  return index == -1 ? '' : tail.substr(index).toLowerCase()
}

/**
 * Generates a random ID.
 */
const uuid4 = () => {
 // From http://stackoverflow.com/questions/105034/how-to-create-a-guid-uuid-in-javascript
 return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
   const r = Math.random() * 16 | 0
   const v = c === 'x' ? r : (r & 0x3 | 0x8)
   return v.toString(16)
 })
}

const normPathCache = new LFUCache(800, 0.8)
/**
 * Remove any '.' in the path. For example: 'Path/.' -> 'Path'
 * @param {string} path
 */
const normalizePath = (path) => {
  const cached = normPathCache.get(path)
  if (cached) return cached
  else {
    if (path.indexOf('\u0000') >= 0) {
      throw new ExtError({
        code: 'InvalidArgument',
        src: `${ERROR_SOURCE}:normalizePath`,
      })
    } else if (!path) {
      throw new ExtError({
        code: 'InvalidArgument',
        src: `${ERROR_SOURCE}:normalizePath`,
      })
    }
    return normPathCache.set(
      path,
      path.split('/')
        .filter((part, i) => (part !== '' || i === 0) && part !== '.')
        .join('/')
    )
  }
}

const dirname = (path) => {
  const last = path.lastIndexOf('/')
  if (last === -1) return '.'
  if (last === 0) return '/'
  return path.slice(0, last)
}

const relativeTo = (path, base) => {
  return base ? path.slice(base.length + (base.endsWith('/') ? 0 : 1)) : path
}

const childOf = (path, base) => {
  if (!path) return false
  path = normalizePath(path)
  base = normalizePath(base)
  return path.startsWith(base + '/') || path === base
}

const basename = (path) => {
  const last = path.lastIndexOf('/')
  if (last === -1) return path
  return path.slice(last + 1)
}

const hasExt = (path, extension) => {
  return path && ext(path) === extension
}

const join = (path1, path2) => {
  if (!path2) return path1
  else {
    return (path1 == null) ? null : (path1.replace(/\/$/, '') + '/' + path2.replace(/^\//, ''))
  }
}

const $warn = console ? console.warn : (() => { })

const FileType = {
  FILE: 0o100000,
  DIRECTORY: 0o40000,
  SYMLINK: 0o120000
}

class Stats {
  /**
   * Provides information about a particular entry in the file system.
   * @param args
   * @param args.size Size of the item in bytes. For directories/symlinks,
   *   this is normally the size of the struct that represents the item.
   * @param args.mode Unix-style file mode (e.g. 0o644)
   * @param args.atimeMs time of last access, in milliseconds since epoch
   * @param args.mtimeMs time of last modification, in milliseconds since epoch
   * @param args.ctimeMs time of last time file status was changed, in milliseconds since epoch
   */
  constructor({size, mode, atimeMs=null, mtimeMs, ctimeMs}) {
    let currentTime = Date.now()
    this.atimeMs = typeof atimeMs !== 'number' ? currentTime : atimeMs
    this.mtimeMs = typeof mtimeMs !== 'number' ? currentTime : mtimeMs
    this.ctimeMs = typeof ctimeMs !== 'number' ? currentTime : ctimeMs
    this.size = size
    this.mode = Stats.normalizeMode(mode)
    this.uid = this.gid = this.ino = 0
  }

  get atime() {
    return new Date(this.atimeMs)
  }

  get mtime() {
    return new Date(this.mtimeMs)
  }

  get ctime() {
    return new Date(this.ctimeMs)
  }

  toBuffer() {
    const buffer = Buffer.alloc(32)
    buffer.writeUInt32LE(this.size, 0)
    buffer.writeUInt32LE(this.mode, 4)
    buffer.writeDoubleLE(this.atimeMs, 8)
    buffer.writeDoubleLE(this.mtimeMs, 16)
    buffer.writeDoubleLE(this.ctimeMs, 24)
    return buffer
  }

  /**
   * @return [Boolean] True if this item is a file.
   */
  isFile() {
    return (this.mode & 0xF000) === FileType.FILE
  }

  /**
   * @return [Boolean] True if this item is a directory.
   */
  isDirectory() {
    return (this.mode & 0xF000) === FileType.DIRECTORY
  }

  /**
   * @return [Boolean] True if this item is a symbolic link (only valid through lstat)
   */
  isSymbolicLink() {
    return (this.mode & 0xF000) === FileType.SYMLINK
  }

  /**
   * Change the mode of the file. We use this helper function to prevent messing
   * up the type of the file, which is encoded in mode.
   */
  chmod(mode) {
    return (this.mode = (this.mode & 0xF000) | mode)
  }

  /**
   * From https://github.com/git/git/blob/master/Documentation/technical/index-format.txt
   *
   * 32-bit mode, split into (high to low bits)
   *
   *  4-bit object type
   *    valid values in binary are 1000 (regular file), 1010 (symbolic link)
   *    and 1110 (gitlink)
   *
   *  3-bit unused
   *
   *  9-bit unix permission. Only 0755 and 0644 are valid for regular files.
   *  Symbolic links and gitlinks have value 0 in this field.
   */
  static normalizeMode(mode) {
    // Note: BrowserFS will use -1 for 'unknown'
    // I need to make it non-negative for these bitshifts to work.
    let type = mode > 0 ? mode >> 12 : 0
    // If it isn't valid, assume it as a 'regular file'
    // 0100 = directory
    // 1000 = regular file
    // 1010 = symlink
    // 1110 = gitlink
    if (
      type !== 4 &&
      type !== 8 &&
      type !== 10 &&
      type !== 14
    ) {
      type = 8
    }
    let permissions = mode & 511
    // Is the file executable? then 755. Else 644.
    if (permissions & 73) {
      permissions = 493
    } else {
      permissions = 420
    }
    // If it's not a regular file, scrub all permissions
    if (type !== 8) permissions = 0
    return (type << 12) + permissions
  }
}

const messageHandlers  = window.webkit && window.webkit.messageHandlers
if (messageHandlers && messageHandlers.file && messageHandlers.system) {
  const IOS_DOCUMENTS_DIR = '/documents/'
  class IOSAdapter {
    constructor({file, system}) {
      this._file = file
      this._system = system
      this._id = 1
      this._callbacks = {}
      this._serverRoot = null
      this.isIOS = true
    }

    async initServer() {
      this.serverUrl = await this.call(this._system, 'initServer')
    }

    launchWebView(url) {
      this._system.postMessage({method: 'launchWebView', url})
    }

    setConsole(value) {
      this._system.postMessage({method: 'setConsole', value})
    }

    getConsole() {
      return this.call(this._system, 'getConsole')
    }

    copyText(value) {
      this._system.postMessage({method: 'copyText', value})
    }

    appVersion() {
      return this.call(this._system, 'appVersion')
    }

    sdkVersion() {
      return 0
    }

    isTablet() {
      return this.call(this._system, 'isTablet')
    }

    versionName() {
      return this.call(this._system, 'versionName')
    }

    async clipboardText() {
      const {contents} = await this.call(this._system, 'clipboardText')
      return contents
    }

    getUrlFor(path) {
      if (!this.serverUrl) {
        throw new Error('IOS Server uninitialized: call initServer first')
      } else {
        return join(this.serverUrl, path)
      }
    }

    async setServerDir(path) {
      path = this._path(path)
      const success = await this.call(this._system, 'setServerDir', {path})
      if (success) {
        this._serverRoot = path
      } else {
        throw new ExtError({
          code: 'ServerFailError',
          message: 'Fail to configure server.'
        })
      }
    }

    // FileSystem

    async getFileContent() {
      const {contents} = await DeviceFileSystem.promisifyStatus(await this.call(this._file, 'getFileContent'))
      return contents
    }

    writeExternal(path, contents, base64) {
      return this.call(this._file, 'writeExternal', {path, contents, base64})
    }

    getStorageDir() {
      return IOS_DOCUMENTS_DIR
    }

    _path(path) {
      return path.slice(11)
    }

    mkdirp(path) {
      return this.call(this._file, 'mkdirp', {path: this._path(path)})
    }

    exists(path) {
      return this.call(this._file, 'exists', {path: this._path(path)})
    }

    readFile(path, encoding) {
      return this.call(this._file, 'readFile', {path: this._path(path), encoding})
    }

    remove(path) {
      return this.call(this._file, 'remove', {path: this._path(path)})
    }

    readlink(path) {
      return this.call(this._file, 'readlink', {path: this._path(path)})
    }

    writelink(path, target) {
      return this.call(this._file, 'writelink', {path: this._path(path), target})
    }

    write(path, contents, base64) {
      return this.call(this._file, 'write', {path: this._path(path), contents, base64})
    }

    readdir(path, skipFiles, skipFolders) {
      return this.call(this._file, 'readdir', {path: this._path(path), skipFiles, skipFolders})
    }

    gitHashObject(type, path) {
      return this.call(this._file, 'gitHashObject', {path: this._path(path), type})
    }

    readdirDeep(path, files, folders, ignoreName='') {
      return this.call(this._file, 'readdirDeep', {path: this._path(path), files, folders, ignoreName})
    }

    lstat(path) {
      return this.call(this._file, 'lstat', {path: this._path(path)})
    }

    mv(src, target) {
      return this.call(this._file, 'mv', {src: this._path(src), target: this._path(target)})
    }

    saveBase64(contents, name) {
      return this.call(this._file, 'saveBase64', {contents, name})
    }

    // Utils

    call(handler, propName, args) {
      args = args || {}
      const id = this._id++
      handler.postMessage(Object.assign({method: propName, id}, args))
      return new Promise((resolve, reject) => {
        this._callbacks[id] = {resolve, reject}
      })
    }

    send(id, args) {
      const fn = this._callbacks[id]
      if (fn) {
        delete this._callbacks[id]
        fn.resolve(args)
      }
    }

    sendError(id, args) {
      const fn = this._callbacks[id]
      if (fn) {
        fn.reject(args)
        delete this._callbacks[id]
      }
    }
  }
  window.Android = window.IOSBridge = new IOSAdapter(messageHandlers)
}


class Observable {
  constructor() {
    this._subscriptions = []
  }

  /**
   * Run all subscriptions with the provided args.
   */
  async run(args) {
    for (let func of this._subscriptions) {
      await func(args)
    }
  }

  /**
   * Subscribe to changes.
   */
  subscribe(fn) {
    this._subscriptions.push(fn)
    return {
      unsubscribe: () => {
        const subs = this._subscriptions
        if (subs.includes(fn)) subs.splice(subs.indexOf(fn), 1)
      }
    }
  }
}
var ObservableClass = Observable


class DeviceFileSystem {
  constructor(device) {
    // Does some checks to make sure Android interface matches expectations
    this.device = device
    this._legacy = null

    if (!device) {
      this._supported = false
    } else {
      this._supported = !!(device.mkdirp && device.exists
        && device.readFile && device.remove && device.readlink && device.writelink
        && device.write && device.readdir && device.readdirDeep && device.lstat
        && device.mv)
    }

    if (!this._supported) {
      $warn('DeviceFileSystem is not operational: interface missing')
    }
  }

  get supported() {
    return this._supported
  }

  get copySupported() {
    return this._supported && !!this.device.copy
  }

  get gitHashSupported() {
    return this._supported && !!this.device.gitHashObject
  }

  get externalFsSupported() {
    return this._supported && !!this.device.getAvailableExternalFilesDirs
  }

  get storageDir() {
    if (this._directory) {
      return this._directory
    } else {
      const device = this.device
      this._directory = device.getStorageDir ? device.getStorageDir() : '~/'
      return this._directory
    }
  }

  async getExternalFsDirsAsync() {
    if (this.externalFsSupported) {
      try {
        return DeviceFileSystem.promisifyStatus(await this.device.getAvailableExternalFilesDirs())
      } catch (e) {
        return null
      }
    } else {
      return null
    }
  }

  async gitHashObject(type, path) {
    const { contents } = await DeviceFileSystem.promisifyStatus(await this.device.gitHashObject(type, path))
    return contents
  }

  async copy(oldpath, path) {
    const { contents } = await DeviceFileSystem.promisifyStatus(await this.device.copy(oldpath, path))
    return contents
  }

  async readFile(path, encoding) {
    const { contents } = await DeviceFileSystem.promisifyStatus(await this.device.readFile(path, encoding))
    if (encoding === 'utf8' || encoding === 'base64') {
      return contents
    } else {
      return Buffer.from(contents, 'base64')
    }
  }

  async remove(path) {
    if (path === this.storageDir) {
      throw new ExtError({
        code: 'CriticalDeletionError',
        src: `fs:remove`,
        message: 'Critical deletion error.',
      })
    } else {
      return DeviceFileSystem.promisifyStatus(await this.device.remove(path))
    }
  }

  async readlink(path) {
    const { contents } = await DeviceFileSystem.promisifyStatus(await this.device.readlink(path))
    return contents
  }

  async writelink(path, target) {
    try {
      return (await DeviceFileSystem.promisifyStatus(await this.device.writelink(path, target)))
    } catch (e) {
      throw new ExtError({
        code: 'SymlinkWriteError',
        path,
        target
      })
    }
  }

  async write(path, contents, base64) {
    return DeviceFileSystem.promisifyStatus(await this.device.write(path, contents, !!base64))
  }

  async exists(path) {
    return this.device.exists(path)
  }

  async mkdirp(path) {
    const { contents } = await DeviceFileSystem.promisifyStatus(await this.device.mkdirp(path))
    return contents
  }

  async mkdir(path) {
    const { contents } = await DeviceFileSystem.promisifyStatus(await this.device.mkdir(path))
    return contents
  }

  async readdir(path, skipFiles, skipFolders) {
    try {
      const result = await DeviceFileSystem.promisifyStatus(
        await this.device.readdir(path, skipFiles, skipFolders)
      )
      return result
    } catch (e) {
      return null
    }
  }

  async readdirDeep(path, files, folders, ignoreName) {
    try {
      return DeviceFileSystem.promisifyStatus(await this.device.readdirDeep(path, files, folders, ignoreName))
    } catch (e) {
      return []
    }
  }

  async lstat(path) {
    try {
      return new Stats(DeviceFileSystem.normalizeStats(await DeviceFileSystem.promisifyStatus(await this.device.lstat(path))))
    } catch (e) {
      return null
    }
  }

  async mv(oldpath, path) {
    const { contents } = await DeviceFileSystem.promisifyStatus(await this.device.mv(oldpath, path))
    return contents
  }

  async writeExternal(uri, content, base64) {
    const device = this.device
    if (device && device.writeExternal) {
      return DeviceFileSystem.promisifyStatus(await device.writeExternal(uri, content, !!base64))
    }
  }

  static async promisifyStatus(json) {
    switch (json) {
      case '{}': {
        return {}
      }
      case '[]': {
        return []
      }
      default: {
        const data = tryParseJSON(json)
        if (data && data.status) {
          throw new ExtError(data)
        } else {
          return data
        }
      }
    }
  }

  static normalizeStats(stats) {
    // Prior to version 3.0.3, version-code 22, there was a bug where mtimeMs was actually in seconds
    const st_mtime = stats.st_mtime || stats.mtimeMs
    const st_ctime = stats.st_ctime || stats.ctimeMs
    const st_atime = stats.st_atime || stats.atimeMs
    Object.assign(stats, {
      mtimeMs: st_mtime * 1000,
      ctimeMs: st_ctime * 1000,
      atimeMs: st_atime * 1000
    })
    return stats
  }
}


var DeviceFileSystemClass = DeviceFileSystem
var DFS = new DeviceFileSystem(window.Android)

var PathUtils = {
  uuid4,
  isIDB,
  ext,
  hasExt,
  dirname,
  basename,
  join,
  relativeTo,
  childOf,
  normalizePath
}

const FileTypeModes = {
  FILE: 0o100644,
  DIRECTORY: 0o40000,
  SYMLINK: 0o120000
}

class GitFileSystem {
  /**
   * Creates a file system wrapper for Git
   * @param {DeviceFileSystem} fs
   */
  constructor (fs) {
    this._store = IDB,
    // DO NOT try to evict anything as this is just a regular store with a max size!
    this._inodes = new LFUCache(1e7, 0)
    this._ino = 1  // Counter

    this._fs = fs
    this.observable = new ObservableClass()
    const scheduleCache = Object.create(null)
    this._scheduleCache = scheduleCache
    // Tricky: Only use these functions externally to prevent deadlock (do not use within this class)
    const echo = path => path
    this.write = SingleThreadScheduler(this._write, echo, scheduleCache)
    this.mkdir = SingleThreadScheduler(this._mkdir, echo, scheduleCache)
    this.writelink = SingleThreadScheduler(this._writelink, echo, scheduleCache)
    this.mv = SingleThreadScheduler(this._mv, echo, scheduleCache)
    this.rm = SingleThreadScheduler(this._rm, echo, scheduleCache)
    this.rmdir = SingleThreadScheduler(this._rmdir, echo, scheduleCache)
    this.copy = SingleThreadScheduler(this._copy, echo, scheduleCache)
    // Git optimization for Android (calculate hashes in native Android code)
    this.gitHashObject = fs.gitHashSupported ? fs.gitHashObject.bind(fs) : null
  }

  clearCache() {
    this._inodes.clear()
    this._ino = 1
  }

  async safeWrite(path, content, tmpDir) {
    const tmpPath = join(tmpDir, path)
    await this.write(tmpPath, content)
    await this.mv(tmpPath, path, { overwrite: true, ignoreInodes: true })
  }

  async writeExternal(uri, content, base64) {
    const fs = this._fs
    return (fs.supported && await fs.writeExternal(uri, content, base64))
  }

  isBinaryContent(content) {
    return content && Buffer.from(content.slice(0, 8000)).some(value => value === 0)
  }

  /**
   * Create an unique identifier for a file, that stays the same thru renames.
   */
  inode(path, renew) {
    const inodes = this._inodes
    return (!renew && inodes.get(path)) || inodes.set(path, this._ino++)
  }

  /**
   * Special sync version for events that can't                      be async.
   */
  inodePath(inode) {
    return inode ? this._inodes.find(inode) : null
  }

  /**
   * Return true if a file exists, false if it doesn't exist.
   * Rethrows errors that aren't related to file existence.
   */
  async exists(path) {
    path = normalizePath(path)
    const { _store, _fs: fs, _inodes: inodes } = this
    if (inodes.get(path)) {
      return true
    } else {
      if (fs.supported && !isIDB(path)) {
        const exists = await fs.exists(path)
        if (exists) {
          // Create cached inode for faster existence lookup
          inodes.set(path, this._ino++)
        }
        return exists
      } else {
        const exists = !!(await _store.files.get({ path })) || !!(await _store.folders.get({ path }))
        if (exists) inodes.set(path, this._ino++)
        return exists
      }
    }
  }

  async lookupFolder(path) {
    const {_store} = this
    const folder = await _store.folders.get({ path })
    if (folder) {
      return folder
    } else {
      const target = await this.readlink(path)
      if (target && target !== path) {
        return (await this.lookupFolder(target))
      } else {
        return null
      }
    }
  }

  async lookupFile(path) {
    const file = await this._store.files.get({ path })
    if (file) {
      if (file.target && file.target !== path) {
        return (await this.lookupFile(file.target))
      } else {
        return file
      }
    } else {
      return null
    }
  }

  async _copy(
    oldpath,
    path,
    { updateStatus, emitEvent, awaitEvent, overwrite }={}
  ) {
    const {_fs: fs} = this
    const code = `${isIDB(oldpath) ? 'I' : 'F'}${isIDB(path) ? 'I' : 'F'}`
    let type
    switch (code) {
      case 'IF':
      case 'FI': {
        throw new ExtError({
          code: 'OperationNotSupported',
          src: `fs:copy`,
          message: 'Moving between IndexedDB and FileSystem is currently not supported!',
          path,
        })
      }
      case 'II': {
        if (await this.exists(path)) {
          if (overwrite) {
            await this._rm(path)
          } else {
            throw new ExtError({
              code: 'DestinationExists',
              src: `fs:copy`,
              message: `Copy operation failed due to target path "${path}" already exists.`,
              path
            })
          }
        }
        const file = await this.lookupFile(oldpath)
        if (file) {
          const filepath = file.path
          const contents = await this.read(filepath)
          await this.write(filepath.replace(oldpath, path), contents)
          type = 'file'
          break
        } else {
          const [files, folders] = await Promise.all([
            this.readdirDeep(oldpath, {files: true, folders: false}),
            this.readdirDeep(oldpath, {files: false, folders: true})
          ])
          folders.unshift(oldpath)
          for (let folder of folders) {
            await this._mkdir(folder.replace(oldpath, path))
          }
          for (let filepath of files) {
            await this.write(filepath.replace(oldpath, path), await this.read(filepath))
          }
          type = 'folder'
          break
        }
      }
      case 'FF': {
        if (fs.copySupported) {
          type = await fs.copy(oldpath, path)
          break
        } else {
          throw new ExtError({
            code: 'OperationNotSupported',
            src: `fs:copy`,
            message: 'Copy operation not supported by your system.',
            path,
          })
        }
      }
    }
    if (emitEvent) {
      const promise = this.observable.run({
        action: 'copy',
        type,
        updateStatus,
        oldpath,
        path
      })
      if (awaitEvent) await promise
    }
    return type
  }

  /**
   * Move an existing file or folder.
   */
  async _mv(
    oldpath,
    path,
    {
      deletion,
      emitEvent, awaitEvent,
      updateStatus,
      copyDelete,
      ignoreInodes,
      overwrite
    }={}
  ) {
    oldpath = normalizePath(oldpath)
    path = normalizePath(path)
    if (oldpath === path) {
      return
    } else if (!overwrite && await this.exists(path)) {
      throw new ExtError({
        code: 'DestinationExists',
        src: `fs:mv`,
        message: `Move operation failed due to target path "${path}" already exists.`,
        path
      })
    }
    const { _store, _inodes, _fs: fs } = this
    let type

    if (copyDelete) {
      type = await this._copy(oldpath, path, { overwrite })
      await this._rm(oldpath)
    } else {
      if (fs.supported && !isIDB(oldpath)) {
        type = await fs.mv(oldpath, path)
      } else {
        if (await this.exists(path)) {
          await this._rm(path, { ignoreInodes })
        }
        const dirpath = dirname(path)
        if (!(await this.exists(dirpath))) {
          await this._mkdir(dirpath, { emitEvent })
        }
        const file = await this.lookupFile(oldpath)
        if (file) {
          await _store.files.update(file.id, { path, mtimeMs: Date.now() })
          type = 'file'
        } else {
          const folder = await this.lookupFolder(oldpath)
          if (folder) {
            const mtimeMs = Date.now()
            await _store.files.where('path').startsWith(oldpath + '/').modify(file => {
              file.path = path + file.path.slice(oldpath.length)
              file.mtimeMs = mtimeMs
            })
            await _store.folders.where('path').startsWith(oldpath + '/').modify(folder => {
              folder.path = path + folder.path.slice(oldpath.length)
              folder.mtimeMs = mtimeMs
            })
            await _store.folders.update(folder.id, { path, mtimeMs })
            type = 'folder'
          } else {
            throw new ExtError({
              code: 'SourceNotFound',
              src: `fs:mv`,
              message: `Move operation failed due to source path "${oldpath}" missing.`,
              oldpath,
            })
          }
        }
      }
    }
    if (!ignoreInodes) {
      _inodes.rename(oldpath, path)
      if (type === 'folder') {
        _inodes.keys
          .filter(p => p.startsWith(oldpath + '/'))
          .forEach(p => _inodes.rename(p, p.replace(oldpath, path)))
      }
    }
    if (emitEvent) {
      const promise = this.observable.run({
        action: 'mv',
        updateStatus,
        oldpath,
        path,
        type,
        deletion
      })
      // Tricky: Can cause deadlocks! (Only needed in tests)
      if (awaitEvent) await promise
    }
    return {
      oldpath,
      path,
      type
    }
  }

  /**
   * Return the contents of a file if it exists, otherwise returns null Promise.
   */
  async read(filepath, options = {}) {
    return this.readFile(filepath, options).catch(() => null)
  }

  /**
   * Return the contents of a file if it exists, otherwise reject Promise.
   */
  async readFile(path, options = {}) {
    path = normalizePath(path)
    const {_fs: fs, _store} = this
    const encoding = options.encoding
    if (fs.supported && !isIDB(path)) {
      return fs.readFile(path, encoding)
    } else {
      const file = await this.lookupFile(path)
      if (file) {
        const data = await _store.data.get(file.fid)
        const text = (data && data.text) || ''
        const dataEncoding = (data && data.encoding) || ''
        if (dataEncoding) {
          if (encoding === 'utf8' && dataEncoding === 'utf8') {
            return text
          } else if (!encoding) {
            return Buffer.from(text, dataEncoding)
          } else {
            return Buffer.from(text, dataEncoding).toString(encoding)
          }
        } else {
          if (encoding === 'utf8') {
            return text
          } else if (encoding) {
            return Buffer.from(text).toString(encoding)
          } else {
            return Buffer.from(text)
          }
        }
      } else {
        throw new ExtError({
          code: 'FileNotFound',
          src: `fs:read`,
          message: `File not found "${path}".`,
          path
        })
      }
    }
  }

  /**
   * Make a directory (or series of nested directories) without throwing an error if it already exists.
   */
  async _mkdir(path, { recursive=false, emitEvent, awaitEvent }={}) {
    path = normalizePath(path)
    const { _fs: fs } = this
    let created
    if (fs.supported && !isIDB(path)) {
      if (recursive) {
        created = await fs.mkdirp(path)
      } else {
        created = await fs.mkdir(path)
      }
    } else {
      if (recursive) {
        const folders = path.split('/').map((name, index, array) => array.slice(0, index + 1).join('/'))
        for (let dirpath of folders) {
          const exists = await this.exists(dirpath)
          if (!exists) {
            try {
              const time = Date.now()
              await this._store.folders.put({
                id: uuid4(),
                path: dirpath,
                mtimeMs: time,
                ctimeMs: time
              })
              this._inodes.set(dirpath, this._ino++)
            } catch (e) {
              console.error(e)
            }
          }
        }
        created = await this.exists(path)
      } else {
        try {
          const time = Date.now()
          await this._store.folders.put({
            id: uuid4(),
            path,
            mtimeMs: time,
            ctimeMs: time
          })
          created = true
        } catch (e) {
          console.error(e)
        }
      }
    }
    if (created && emitEvent) {
      const promise = this.observable.run({
        action: 'mkdir',
        path,
        type: 'folder'
      })
      if (awaitEvent) await promise
    }
  }

  /**
   * Write a file (creating missing directories if need be) without throwing errors.
   */
  async _write(path, contents, { mode, target, mkdir, updateStatus, emitEvent, awaitEvent }={}) {
    path = normalizePath(path)
    contents = contents || ''
    const { _fs: fs, _store } = this

    const dir = dirname(path)
    if (mkdir && !(await this.exists(dir))) {
      await this._mkdir(dir, { recursive: true, emitEvent })
    }

    const binary = GitFileSystem.isArrayBuffer(contents)
    let mtimeMs, size
    if (fs.supported && !isIDB(path)) {
      ({mtimeMs, size, mode} = await fs.write(path, binary ? Buffer.from(contents).toString('base64') : contents, binary))
      if (emitEvent) {
        const promise = this.observable.run({
          action: 'write',
          path,
          type: 'file',
          updateStatus
        })
        if (awaitEvent) await promise
      }
    } else {
      const file = await this.lookupFile(path)
      const content = binary ? castAsReadableArrayBuffer(contents) : contents
      size = content.byteLength || content.length
      mtimeMs = Date.now()
      const ctimeMs = file ? file.ctimeMs : mtimeMs
      const fid = file ? file.id : uuid4()
      await _store.files.put({
        id: fid, fid,
        path, target,
        mode, size,
        ctimeMs, mtimeMs,
      })
      await _store.data.put({
        fid,
        text: content,
        encoding: binary ? 'binary' : 'utf8'
      })
      if (emitEvent) {
        const promise = this.observable.run({
          action: 'write',
          path,
          type: 'file',
          idb: true,
          target,
          mode,
          content,
          updateStatus
        })
        if (awaitEvent) await promise
      }
    }
    return { mode, mtimeMs, type: 'file', ino: 0, size }
  }

  /**
   * Delete a file without throwing an error if it is already deleted.
   */
  async _rm(path, { tmpDir, updateStatus, emitEvent, awaitEvent, ignoreInodes }={}) {
    path = normalizePath(path)
    const { _fs: fs, _store, _inodes } = this
    let removed = false
    if (tmpDir) {
      // Use a unique id to prevent collisions
      return this._mv(path, `${tmpDir}${path}~${uuid4()}`, { updateStatus, emitEvent, awaitEvent, deletion: true })
    } else {
      const stats = await this.lstat(path)
      if (stats) {
        if (stats.isDirectory()) {
          return this._rmdir(path, { updateStatus })
        } else {
          if (fs.supported && !isIDB(path)) {
            removed = await fs.remove(path)
          } else {
            const file = await _store.files.get({ path })  // Note, rm should not follow symlinks
            if (file) {
              await Promise.all([
                _store.files.delete(file.id),
                _store.data.delete(file.fid)
              ])
              removed = true
            }
          }
        }
      } else {
        removed = true
      }
    }
    if (!ignoreInodes) {
      _inodes.del(path)
    }
    if (removed) {
      if (emitEvent) {
        const promise = this.observable.run({
          action: 'rm',
          updateStatus,
          oldpath: path,
          path: null,
          type: 'file'
        })
        if (awaitEvent) await promise
      }
      return {
        oldpath: path,
        path: null,
        type: 'file'
      }
    } else {
      throw new ExtError({
        code: 'RemoveFailed',
        src: `fs:rm`,
        message: `Could not remove ${path}.`,
        path,
      })
    }
  }

  /**
   * Assume removing a directory.
   */
  async _rmdir(path, { tmpDir, updateStatus, emitEvent, awaitEvent }={}) {
    path = normalizePath(path)
    const { _inodes, _fs: fs, _store } = this
    const startPath = path + '/'
    _inodes.keys
      .filter(p => p === path || p.startsWith(startPath))
      .forEach(p => _inodes.del(p))
    if (tmpDir) {
      return this._mv(path, tmpDir + path, { updateStatus, deletion: true })
    } else {
      const stats = await this.lstat(path)
      let removed = false
      if (stats) {
        if (stats.isDirectory()) {
          if (fs.supported && !isIDB(path)) {
            removed = await fs.remove(path)
          } else {
            const files = _store.files.where('path').startsWith(startPath)
            const fids = (await files.toArray()).map(f => f.fid)
            await Promise.all([
              _store.folders.where('path').equals(path).delete(),
              files.delete(),
              _store.data.where('fid').anyOf(fids).delete(),
              _store.folders.where('path').startsWith(startPath).delete()
            ])
            removed = true
          }
        } else {
          throw new ExtError({
            code: 'NotADirectory',
            src: `fs:rmdir`,
            message: `${path} is not a directory.`,
            path,
            stats,
          })
        }
      } else {
        removed = true
      }
      if (removed) {
        if (emitEvent) {
          const promise = this.observable.run({
            action: 'rmdir',
            updateStatus,
            oldpath: path,
            path: null,
            type: 'folder'
          })
          if (awaitEvent) await promise
        }
        return {
          oldpath: path,
          path: null,
          type: 'folder'
        }
      } else {
        throw new ExtError({
          code: 'RemoveFailed',
          src: `fs:rmdir`,
          message: `Could not remove ${path}.`,
          path,
        })
      }
    }
  }

  /**
   * Count number of files under a directory (including files in subdirectories).
   */
  async fileCount(dirname) {
    const children = await this.readdirDeep(dirname, { files: true })
    return children ? children.length : null
  }

  /**
   * Read a directory without throwing an error is the directory doesn't exist
   */
  async readdir(path, { skipFiles = false, skipFolders = false }={}) {
    path = normalizePath(path)
    const {_fs: fs, _store} = this
    let paths
    if (fs.supported && !isIDB(path)) {
      paths = await fs.readdir(path, skipFiles, skipFolders)
      if (paths && paths.length) {
        return paths
      } else {
        return []
      }
    }
    const folder = await this.lookupFolder(path)
    if (folder) {
      const startPath = folder.path + '/'
      const l = startPath.length
      let foldersPromise = skipFolders ? [] : _store.folders.where('path').startsWith(startPath).filter(f => !f.path.slice(l).includes('/')).keys()
      let filesPromise = skipFiles ? [] : _store.files.where('path').startsWith(startPath).filter(f => !f.path.slice(l).includes('/')).keys()
      paths = (await foldersPromise).concat(await filesPromise).map(p => p.slice(l))
      return paths
    } else {
      return []
    }
  }

  /**
   * Return a flat list of all the files nested inside a directory
   */
  async readdirDeep(dirname, { files = true, folders = false, relative = false, ignoreName='' }={}) {
    const { _store, _fs: fs } = this
    dirname = normalizePath(dirname)
    const startPath = dirname + '/'
    const l = startPath.length
    let paths
    if (fs.supported && !isIDB(dirname)) {
      paths = await fs.readdirDeep(dirname, files, folders, ignoreName)
    } else {
      const [filesList, foldersList] = await Promise.all([
        files ? _store.files.where('path').startsWith(startPath).keys() : [],
        folders ? _store.folders.where('path').startsWith(startPath).keys() : []
      ])
      paths = foldersList.concat(filesList)
    }
    if (paths) {
      if (ignoreName) {
        const ignoreNames = new Set(ignoreName.split(':'))
        const ignoreRegex = new RegExp(`/(${ignoreName.replace(/:/g, '|').replace(/\./g, '\\.')})/`)
        paths = paths.filter(path => !ignoreRegex.test(path) && !ignoreNames.has(basename(path)))
      }
      if (relative) paths = paths.map(p => p.slice(l))
    }
    return paths
  }

  /**
   * Return the Stats of a file/symlink if it exists, otherwise returns null.
   * Rethrows errors that aren't related to file existance.
   */
  async lstat(path) {
    path = normalizePath(path)
    const {_store, _fs: fs} = this
    if (fs.supported && !isIDB(path)) {
      return await fs.lstat(path)
    } else {
      const file = await _store.files.get({ path })
      if (file) {
        if (file.target) {
          return new Stats({
            size: file.size || 0,
            mode: FileTypeModes.SYMLINK,
            mtimeMs: file.mtimeMs,
            ctimeMs: file.ctimeMs
          })
        } else {
          return new Stats({
            size: file.size || 0,
            mode: FileTypeModes.FILE,
            mtimeMs: file.mtimeMs,
            ctimeMs: file.ctimeMs
          })
        }
      } else {
        const folder = await _store.folders.get({ path })
        if (folder) {
          return new Stats({
            size: 0,
            mode: FileTypeModes.DIRECTORY,
            mtimeMs: folder.mtimeMs,
            ctimeMs: folder.ctimeMs
          })
        } else {
          return null
        }
      }
    }
  }

  /**
   * Return the file size of a file or 0 otherwise.
   */
  async size(path) {
    return ((await this.lstat(path)) || {size: 0}).size
  }

  /**
   * Reads the contents of a symlink if it exists, otherwise returns null.
   * Rethrows errors that aren't related to file existance.
   */
  async readlink(path) {
    path = normalizePath(path)
    const {_fs: fs, _store} = this
    if (fs.supported && !isIDB(path)) return fs.readlink(path)
    const file = await _store.files.get({ path })
    return (file && file.target) || null
  }

  /**
   * Write the contents of buffer to a symlink.
   */
  async _writelink(filepath, buffer) {
    filepath = normalizePath(filepath)
    const {_fs: fs} = this
    const dirpath = dirname(filepath)
    if (!this.exists(dirpath)) {
      await this._mkdir(dirpath)
    }
    const target = buffer.toString('utf8')
    if (fs.supported && !isIDB(filepath)) {
      return fs.writelink(filepath, target)
    } else {
      return this._write(filepath, '', { target, mode: FileTypeModes.SYMLINK })
    }
  }

  static isArrayBuffer(value) {
    return value instanceof ArrayBuffer || (value && value.buffer instanceof ArrayBuffer && value.byteLength !== undefined)
  }
}

var GitFileSystemClass = GitFileSystem
var GFS = new GitFileSystem(DFS)


function tryParseJSON(json) {
  try {
    return JSON.parse(json) || null
  } catch (e) {
    return null
  }
}

/**
 * Converts any buffer interface to an ArrayBuffer pointing to the same memory.
 * @param {Buffer|Uint8Array|ArrayBuffer} buf
 */
function castAsReadableArrayBuffer(buf) {
  if (buf instanceof ArrayBuffer) {
    return buf
  } else if (buf instanceof Uint8Array) {
    // Check if is a subarray
    if (buf.byteOffset === 0 && buf.byteLength === buf.buffer.byteLength) {
      return buf.buffer
    } else {
      // Return a copy of subarray
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
    }
  } else if (Buffer.isBuffer(buf)) {
    return buf.buffer
  } else {
    throw new Error('Argument type not recognized: ' + (typeof buf))
  }
}


class Environ {
  /**
   * Creates a file system wrapper for Git
   * @param {DeviceFileSystem} fs
   */
  constructor(fs) {
    this._fs = fs
    this.locale = 'en'
    this._nodeStoragePath = null
  }

  get locationSearch() {
    return window.location.search || ''
  }

  get locationPathname() {
    return window.location.pathname || '/'
  }

  queryVariable(variable, url) {
    const query = url ? url.split('?').pop() : this.locationSearch.substring(1);
    const vars = query.split('&');
    for (let i = 0; i < vars.length; i++) {
        let pair = vars[i].split('=');
        if (decodeURIComponent(pair[0]) == variable) {
            return decodeURIComponent(pair[1]);
        }
    }
  }

  get isDebugging() {
    return this.queryVariable('debug')
  }

  get sandboxUrl() {
    return window.location.origin.includes('localhost') ? 'http://localhost:8321' : 'https://run.spck.io'
  }

  get accountUrl() {
    return this.isDebugging ? 'http://localhost:8081' : 'https://account.spck.io/v3'
  }

  get apiUrl() {
    return this.isDebugging ? 'https://localhost' : 'https://api-v3.spck.io'
  }

  get siteUrl() {
    return 'https://spck.io'
  }

  setNodeJsModuleStoragePath(nodeStoragePath) {
    this._nodeStoragePath = nodeStoragePath
  }

  getNodeJsModuleStoragePath() {
    return this._nodeStoragePath
  }

  async getExternalFsDirsAsync() {
    const dirs = await this._fs.getExternalFsDirsAsync()
    if (dirs === null) {
      return null
    } else if (dirs && dirs.length) {
      dirs[0].name = 'External'
      dirs[0].value = 'external'
      dirs.slice(1, 3).forEach((dir, i) => {
        dir.name = `SD${i+1}`
        dir.value = `SD${i+1}`
      })
      return dirs
    } else {
      return []
    }
  }

  getInternalDir(path) {
    if (!this._internalDir) {
      this._internalDir = this._fs.supported ? this._fs.storageDir : 'idb'
    }
    return join(this._internalDir, path)
  }

  projectConfigPath(dir) {
    return join(dir, '.projects')
  }

  gitConfigPath() {
    return this.getInternalDir('.gitconfig')
  }

  preferencesPath() {
    return this.getInternalDir('.prefs')
  }

  settingsConfigPath() {
    return this.getInternalDir('.settings')
  }

  globalTasksConfigPath() {
    return this.getInternalDir('.metadata/.tasks/.global')
  }

  cachedUserDataPath() {
    return this.getInternalDir('.metadata/.user')
  }

  fontsDir() {
    return this.getInternalDir('.metadata/.fonts')
  }

  signatureDir() {
    return this.getInternalDir('.metadata/.sig')
  }

  projectTasksConfigPath(dir) {
    return join(`${dirname(dir)}/.metadata/.tasks`, basename(dir))
  }

  projectInfoPath(dir) {
    return join(`${dirname(dir)}/.metadata/.info`, basename(dir))
  }

  tmpDir(dir) {
    return join(`${dirname(dir)}/.tmp`, basename(dir))
  }

  metadataPath(dir) {
    return join(`${dirname(dir)}/.metadata`, basename(dir))
  }

  trashDir(dir) {
    return join(`${dirname(dir)}/.trash`, basename(dir))
  }
}

var ENV = new Environ(DFS)
/* exported GitFileSystemClass, GFS, ENV, DeviceFileSystemClass, PathUtils, ObservableClass */

class ExtError extends Error {
  constructor(args) {
    super(args.message)
    Object.assign(this, args)
    this.name = this.code
  }
}

const ERROR_SOURCE = 'filesystem'
const isIDB = path => path === 'idb' || path.startsWith('idb/')

const ext = (path) => {
  if (path === null) return null
  const tail = basename(path)
  const index = tail.lastIndexOf('.')
  return index == -1 ? '' : tail.substr(index).toLowerCase()
}

/**
 * Generates a random ID.
 */
const uuid4 = () => {
 // From http://stackoverflow.com/questions/105034/how-to-create-a-guid-uuid-in-javascript
 return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
   const r = Math.random() * 16 | 0
   const v = c === 'x' ? r : (r & 0x3 | 0x8)
   return v.toString(16)
 })
}

const normPathCache = new LFUCache(800, 0.8)
/**
 * Remove any '.' in the path. For example: 'Path/.' -> 'Path'
 * @param {string} path
 */
const normalizePath = (path) => {
  const cached = normPathCache.get(path)
  if (cached) return cached
  else {
    if (path.indexOf('\u0000') >= 0) {
      throw new ExtError({
        code: 'InvalidArgument',
        src: `${ERROR_SOURCE}:normalizePath`,
      })
    } else if (!path) {
      throw new ExtError({
        code: 'InvalidArgument',
        src: `${ERROR_SOURCE}:normalizePath`,
      })
    }
    return normPathCache.set(
      path,
      path.split('/')
        .filter((part, i) => (part !== '' || i === 0) && part !== '.')
        .join('/')
    )
  }
}

const dirname = (path) => {
  const last = path.lastIndexOf('/')
  if (last === -1) return '.'
  if (last === 0) return '/'
  return path.slice(0, last)
}

const relativeTo = (path, base) => {
  return base ? path.slice(base.length + (base.endsWith('/') ? 0 : 1)) : path
}

const childOf = (path, base) => {
  if (!path) return false
  path = normalizePath(path)
  base = normalizePath(base)
  return path.startsWith(base + '/') || path === base
}

const basename = (path) => {
  const last = path.lastIndexOf('/')
  if (last === -1) return path
  return path.slice(last + 1)
}

const hasExt = (path, extension) => {
  return path && ext(path) === extension
}

const join = (path1, path2) => {
  if (!path2) return path1
  else {
    return (path1 == null) ? null : (path1.replace(/\/$/, '') + '/' + path2.replace(/^\//, ''))
  }
}

const $warn = console ? console.warn : (() => { })

const FileType = {
  FILE: 0o100000,
  DIRECTORY: 0o40000,
  SYMLINK: 0o120000
}

class Stats {
  /**
   * Provides information about a particular entry in the file system.
   * @param args
   * @param args.size Size of the item in bytes. For directories/symlinks,
   *   this is normally the size of the struct that represents the item.
   * @param args.mode Unix-style file mode (e.g. 0o644)
   * @param args.atimeMs time of last access, in milliseconds since epoch
   * @param args.mtimeMs time of last modification, in milliseconds since epoch
   * @param args.ctimeMs time of last time file status was changed, in milliseconds since epoch
   */
  constructor({size, mode, atimeMs=null, mtimeMs, ctimeMs}) {
    let currentTime = Date.now()
    this.atimeMs = typeof atimeMs !== 'number' ? currentTime : atimeMs
    this.mtimeMs = typeof mtimeMs !== 'number' ? currentTime : mtimeMs
    this.ctimeMs = typeof ctimeMs !== 'number' ? currentTime : ctimeMs
    this.size = size
    this.mode = Stats.normalizeMode(mode)
    this.uid = this.gid = this.ino = 0
  }

  get atime() {
    return new Date(this.atimeMs)
  }

  get mtime() {
    return new Date(this.mtimeMs)
  }

  get ctime() {
    return new Date(this.ctimeMs)
  }

  toBuffer() {
    const buffer = Buffer.alloc(32)
    buffer.writeUInt32LE(this.size, 0)
    buffer.writeUInt32LE(this.mode, 4)
    buffer.writeDoubleLE(this.atimeMs, 8)
    buffer.writeDoubleLE(this.mtimeMs, 16)
    buffer.writeDoubleLE(this.ctimeMs, 24)
    return buffer
  }

  /**
   * @return [Boolean] True if this item is a file.
   */
  isFile() {
    return (this.mode & 0xF000) === FileType.FILE
  }

  /**
   * @return [Boolean] True if this item is a directory.
   */
  isDirectory() {
    return (this.mode & 0xF000) === FileType.DIRECTORY
  }

  /**
   * @return [Boolean] True if this item is a symbolic link (only valid through lstat)
   */
  isSymbolicLink() {
    return (this.mode & 0xF000) === FileType.SYMLINK
  }

  /**
   * Change the mode of the file. We use this helper function to prevent messing
   * up the type of the file, which is encoded in mode.
   */
  chmod(mode) {
    return (this.mode = (this.mode & 0xF000) | mode)
  }

  /**
   * From https://github.com/git/git/blob/master/Documentation/technical/index-format.txt
   *
   * 32-bit mode, split into (high to low bits)
   *
   *  4-bit object type
   *    valid values in binary are 1000 (regular file), 1010 (symbolic link)
   *    and 1110 (gitlink)
   *
   *  3-bit unused
   *
   *  9-bit unix permission. Only 0755 and 0644 are valid for regular files.
   *  Symbolic links and gitlinks have value 0 in this field.
   */
  static normalizeMode(mode) {
    // Note: BrowserFS will use -1 for 'unknown'
    // I need to make it non-negative for these bitshifts to work.
    let type = mode > 0 ? mode >> 12 : 0
    // If it isn't valid, assume it as a 'regular file'
    // 0100 = directory
    // 1000 = regular file
    // 1010 = symlink
    // 1110 = gitlink
    if (
      type !== 4 &&
      type !== 8 &&
      type !== 10 &&
      type !== 14
    ) {
      type = 8
    }
    let permissions = mode & 511
    // Is the file executable? then 755. Else 644.
    if (permissions & 73) {
      permissions = 493
    } else {
      permissions = 420
    }
    // If it's not a regular file, scrub all permissions
    if (type !== 8) permissions = 0
    return (type << 12) + permissions
  }
}

const messageHandlers  = window.webkit && window.webkit.messageHandlers
if (messageHandlers && messageHandlers.file && messageHandlers.system) {
  const IOS_DOCUMENTS_DIR = '/documents/'
  class IOSAdapter {
    constructor({file, system}) {
      this._file = file
      this._system = system
      this._id = 1
      this._callbacks = {}
      this._serverRoot = null
      this.isIOS = true
    }

    async initServer() {
      this.serverUrl = await this.call(this._system, 'initServer')
    }

    launchWebView(url) {
      this._system.postMessage({method: 'launchWebView', url})
    }

    setConsole(value) {
      this._system.postMessage({method: 'setConsole', value})
    }

    getConsole() {
      return this.call(this._system, 'getConsole')
    }

    copyText(value) {
      this._system.postMessage({method: 'copyText', value})
    }

    appVersion() {
      return this.call(this._system, 'appVersion')
    }

    sdkVersion() {
      return 0
    }

    isTablet() {
      return this.call(this._system, 'isTablet')
    }

    versionName() {
      return this.call(this._system, 'versionName')
    }

    async clipboardText() {
      const {contents} = await this.call(this._system, 'clipboardText')
      return contents
    }

    getUrlFor(path) {
      if (!this.serverUrl) {
        throw new Error('IOS Server uninitialized: call initServer first')
      } else {
        return join(this.serverUrl, path)
      }
    }

    async setServerDir(path) {
      path = this._path(path)
      const success = await this.call(this._system, 'setServerDir', {path})
      if (success) {
        this._serverRoot = path
      } else {
        throw new ExtError({
          code: 'ServerFailError',
          message: 'Fail to configure server.'
        })
      }
    }

    // FileSystem

    async getFileContent() {
      const {contents} = await DeviceFileSystem.promisifyStatus(await this.call(this._file, 'getFileContent'))
      return contents
    }

    writeExternal(path, contents, base64) {
      return this.call(this._file, 'writeExternal', {path, contents, base64})
    }

    getStorageDir() {
      return IOS_DOCUMENTS_DIR
    }

    _path(path) {
      return path.slice(11)
    }

    mkdirp(path) {
      return this.call(this._file, 'mkdirp', {path: this._path(path)})
    }

    exists(path) {
      return this.call(this._file, 'exists', {path: this._path(path)})
    }

    readFile(path, encoding) {
      return this.call(this._file, 'readFile', {path: this._path(path), encoding})
    }

    remove(path) {
      return this.call(this._file, 'remove', {path: this._path(path)})
    }

    readlink(path) {
      return this.call(this._file, 'readlink', {path: this._path(path)})
    }

    writelink(path, target) {
      return this.call(this._file, 'writelink', {path: this._path(path), target})
    }

    write(path, contents, base64) {
      return this.call(this._file, 'write', {path: this._path(path), contents, base64})
    }

    readdir(path, skipFiles, skipFolders) {
      return this.call(this._file, 'readdir', {path: this._path(path), skipFiles, skipFolders})
    }

    gitHashObject(type, path) {
      return this.call(this._file, 'gitHashObject', {path: this._path(path), type})
    }

    readdirDeep(path, files, folders, ignoreName='') {
      return this.call(this._file, 'readdirDeep', {path: this._path(path), files, folders, ignoreName})
    }

    lstat(path) {
      return this.call(this._file, 'lstat', {path: this._path(path)})
    }

    mv(src, target) {
      return this.call(this._file, 'mv', {src: this._path(src), target: this._path(target)})
    }

    saveBase64(contents, name) {
      return this.call(this._file, 'saveBase64', {contents, name})
    }

    // Utils

    call(handler, propName, args) {
      args = args || {}
      const id = this._id++
      handler.postMessage(Object.assign({method: propName, id}, args))
      return new Promise((resolve, reject) => {
        this._callbacks[id] = {resolve, reject}
      })
    }

    send(id, args) {
      const fn = this._callbacks[id]
      if (fn) {
        delete this._callbacks[id]
        fn.resolve(args)
      }
    }

    sendError(id, args) {
      const fn = this._callbacks[id]
      if (fn) {
        fn.reject(args)
        delete this._callbacks[id]
      }
    }
  }
  window.Android = window.IOSBridge = new IOSAdapter(messageHandlers)
}


class Observable {
  constructor() {
    this._subscriptions = []
  }

  /**
   * Run all subscriptions with the provided args.
   */
  async run(args) {
    for (let func of this._subscriptions) {
      await func(args)
    }
  }

  /**
   * Subscribe to changes.
   */
  subscribe(fn) {
    this._subscriptions.push(fn)
    return {
      unsubscribe: () => {
        const subs = this._subscriptions
        if (subs.includes(fn)) subs.splice(subs.indexOf(fn), 1)
      }
    }
  }
}
var ObservableClass = Observable


class DeviceFileSystem {
  constructor(device) {
    // Does some checks to make sure Android interface matches expectations
    this.device = device
    this._legacy = null

    if (!device) {
      this._supported = false
    } else {
      this._supported = !!(device.mkdirp && device.exists
        && device.readFile && device.remove && device.readlink && device.writelink
        && device.write && device.readdir && device.readdirDeep && device.lstat
        && device.mv)
    }

    if (!this._supported) {
      $warn('DeviceFileSystem is not operational: interface missing')
    }
  }

  get supported() {
    return this._supported
  }

  get copySupported() {
    return this._supported && !!this.device.copy
  }

  get gitHashSupported() {
    return this._supported && !!this.device.gitHashObject
  }

  get externalFsSupported() {
    return this._supported && !!this.device.getAvailableExternalFilesDirs
  }

  get storageDir() {
    if (this._directory) {
      return this._directory
    } else {
      const device = this.device
      this._directory = device.getStorageDir ? device.getStorageDir() : '~/'
      return this._directory
    }
  }

  async getExternalFsDirsAsync() {
    if (this.externalFsSupported) {
      try {
        return DeviceFileSystem.promisifyStatus(await this.device.getAvailableExternalFilesDirs())
      } catch (e) {
        return null
      }
    } else {
      return null
    }
  }

  async gitHashObject(type, path) {
    const { contents } = await DeviceFileSystem.promisifyStatus(await this.device.gitHashObject(type, path))
    return contents
  }

  async copy(oldpath, path) {
    const { contents } = await DeviceFileSystem.promisifyStatus(await this.device.copy(oldpath, path))
    return contents
  }

  async readFile(path, encoding) {
    const { contents } = await DeviceFileSystem.promisifyStatus(await this.device.readFile(path, encoding))
    if (encoding === 'utf8' || encoding === 'base64') {
      return contents
    } else {
      return Buffer.from(contents, 'base64')
    }
  }

  async remove(path) {
    if (path === this.storageDir) {
      throw new ExtError({
        code: 'CriticalDeletionError',
        src: `fs:remove`,
        message: 'Critical deletion error.',
      })
    } else {
      return DeviceFileSystem.promisifyStatus(await this.device.remove(path))
    }
  }

  async readlink(path) {
    const { contents } = await DeviceFileSystem.promisifyStatus(await this.device.readlink(path))
    return contents
  }

  async writelink(path, target) {
    try {
      return (await DeviceFileSystem.promisifyStatus(await this.device.writelink(path, target)))
    } catch (e) {
      throw new ExtError({
        code: 'SymlinkWriteError',
        path,
        target
      })
    }
  }

  async write(path, contents, base64) {
    return DeviceFileSystem.promisifyStatus(await this.device.write(path, contents, !!base64))
  }

  async exists(path) {
    return this.device.exists(path)
  }

  async mkdirp(path) {
    const { contents } = await DeviceFileSystem.promisifyStatus(await this.device.mkdirp(path))
    return contents
  }

  async mkdir(path) {
    const { contents } = await DeviceFileSystem.promisifyStatus(await this.device.mkdir(path))
    return contents
  }

  async readdir(path, skipFiles, skipFolders) {
    try {
      const result = await DeviceFileSystem.promisifyStatus(
        await this.device.readdir(path, skipFiles, skipFolders)
      )
      return result
    } catch (e) {
      return null
    }
  }

  async readdirDeep(path, files, folders, ignoreName) {
    try {
      return DeviceFileSystem.promisifyStatus(await this.device.readdirDeep(path, files, folders, ignoreName))
    } catch (e) {
      return []
    }
  }

  async lstat(path) {
    try {
      return new Stats(DeviceFileSystem.normalizeStats(await DeviceFileSystem.promisifyStatus(await this.device.lstat(path))))
    } catch (e) {
      return null
    }
  }

  async mv(oldpath, path) {
    const { contents } = await DeviceFileSystem.promisifyStatus(await this.device.mv(oldpath, path))
    return contents
  }

  async writeExternal(uri, content, base64) {
    const device = this.device
    if (device && device.writeExternal) {
      return DeviceFileSystem.promisifyStatus(await device.writeExternal(uri, content, !!base64))
    }
  }

  static async promisifyStatus(json) {
    switch (json) {
      case '{}': {
        return {}
      }
      case '[]': {
        return []
      }
      default: {
        const data = tryParseJSON(json)
        if (data && data.status) {
          throw new ExtError(data)
        } else {
          return data
        }
      }
    }
  }

  static normalizeStats(stats) {
    // Prior to version 3.0.3, version-code 22, there was a bug where mtimeMs was actually in seconds
    const st_mtime = stats.st_mtime || stats.mtimeMs
    const st_ctime = stats.st_ctime || stats.ctimeMs
    const st_atime = stats.st_atime || stats.atimeMs
    Object.assign(stats, {
      mtimeMs: st_mtime * 1000,
      ctimeMs: st_ctime * 1000,
      atimeMs: st_atime * 1000
    })
    return stats
  }
}


var DeviceFileSystemClass = DeviceFileSystem
var DFS = new DeviceFileSystem(window.Android)

var PathUtils = {
  uuid4,
  isIDB,
  ext,
  hasExt,
  dirname,
  basename,
  join,
  relativeTo,
  childOf,
  normalizePath
}

const FileTypeModes = {
  FILE: 0o100644,
  DIRECTORY: 0o40000,
  SYMLINK: 0o120000
}

class GitFileSystem {
  /**
   * Creates a file system wrapper for Git
   * @param {DeviceFileSystem} fs
   */
  constructor (fs) {
    this._store = IDB,
    // DO NOT try to evict anything as this is just a regular store with a max size!
    this._inodes = new LFUCache(1e7, 0)
    this._ino = 1  // Counter

    this._fs = fs
    this.observable = new ObservableClass()
    const scheduleCache = Object.create(null)
    this._scheduleCache = scheduleCache
    // Tricky: Only use these functions externally to prevent deadlock (do not use within this class)
    const echo = path => path
    this.write = SingleThreadScheduler(this._write, echo, scheduleCache)
    this.mkdir = SingleThreadScheduler(this._mkdir, echo, scheduleCache)
    this.writelink = SingleThreadScheduler(this._writelink, echo, scheduleCache)
    this.mv = SingleThreadScheduler(this._mv, echo, scheduleCache)
    this.rm = SingleThreadScheduler(this._rm, echo, scheduleCache)
    this.rmdir = SingleThreadScheduler(this._rmdir, echo, scheduleCache)
    this.copy = SingleThreadScheduler(this._copy, echo, scheduleCache)
    // Git optimization for Android (calculate hashes in native Android code)
    this.gitHashObject = fs.gitHashSupported ? fs.gitHashObject.bind(fs) : null
  }

  clearCache() {
    this._inodes.clear()
    this._ino = 1
  }

  async safeWrite(path, content, tmpDir) {
    const tmpPath = join(tmpDir, path)
    await this.write(tmpPath, content)
    await this.mv(tmpPath, path, { overwrite: true, ignoreInodes: true })
  }

  async writeExternal(uri, content, base64) {
    const fs = this._fs
    return (fs.supported && await fs.writeExternal(uri, content, base64))
  }

  isBinaryContent(content) {
    return content && Buffer.from(content.slice(0, 8000)).some(value => value === 0)
  }

  /**
   * Create an unique identifier for a file, that stays the same thru renames.
   */
  inode(path, renew) {
    const inodes = this._inodes
    return (!renew && inodes.get(path)) || inodes.set(path, this._ino++)
  }

  /**
   * Special sync version for events that can't                      be async.
   */
  inodePath(inode) {
    return inode ? this._inodes.find(inode) : null
  }

  /**
   * Return true if a file exists, false if it doesn't exist.
   * Rethrows errors that aren't related to file existence.
   */
  async exists(path) {
    path = normalizePath(path)
    const { _store, _fs: fs, _inodes: inodes } = this
    if (inodes.get(path)) {
      return true
    } else {
      if (fs.supported && !isIDB(path)) {
        const exists = await fs.exists(path)
        if (exists) {
          // Create cached inode for faster existence lookup
          inodes.set(path, this._ino++)
        }
        return exists
      } else {
        const exists = !!(await _store.files.get({ path })) || !!(await _store.folders.get({ path }))
        if (exists) inodes.set(path, this._ino++)
        return exists
      }
    }
  }

  async lookupFolder(path) {
    const {_store} = this
    const folder = await _store.folders.get({ path })
    if (folder) {
      return folder
    } else {
      const target = await this.readlink(path)
      if (target && target !== path) {
        return (await this.lookupFolder(target))
      } else {
        return null
      }
    }
  }

  async lookupFile(path) {
    const file = await this._store.files.get({ path })
    if (file) {
      if (file.target && file.target !== path) {
        return (await this.lookupFile(file.target))
      } else {
        return file
      }
    } else {
      return null
    }
  }

  async _copy(
    oldpath,
    path,
    { updateStatus, emitEvent, awaitEvent, overwrite }={}
  ) {
    const {_fs: fs} = this
    const code = `${isIDB(oldpath) ? 'I' : 'F'}${isIDB(path) ? 'I' : 'F'}`
    let type
    switch (code) {
      case 'IF':
      case 'FI': {
        throw new ExtError({
          code: 'OperationNotSupported',
          src: `fs:copy`,
          message: 'Moving between IndexedDB and FileSystem is currently not supported!',
          path,
        })
      }
      case 'II': {
        if (await this.exists(path)) {
          if (overwrite) {
            await this._rm(path)
          } else {
            throw new ExtError({
              code: 'DestinationExists',
              src: `fs:copy`,
              message: `Copy operation failed due to target path "${path}" already exists.`,
              path
            })
          }
        }
        const file = await this.lookupFile(oldpath)
        if (file) {
          const filepath = file.path
          const contents = await this.read(filepath)
          await this.write(filepath.replace(oldpath, path), contents)
          type = 'file'
          break
        } else {
          const [files, folders] = await Promise.all([
            this.readdirDeep(oldpath, {files: true, folders: false}),
            this.readdirDeep(oldpath, {files: false, folders: true})
          ])
          folders.unshift(oldpath)
          for (let folder of folders) {
            await this._mkdir(folder.replace(oldpath, path))
          }
          for (let filepath of files) {
            await this.write(filepath.replace(oldpath, path), await this.read(filepath))
          }
          type = 'folder'
          break
        }
      }
      case 'FF': {
        if (fs.copySupported) {
          type = await fs.copy(oldpath, path)
          break
        } else {
          throw new ExtError({
            code: 'OperationNotSupported',
            src: `fs:copy`,
            message: 'Copy operation not supported by your system.',
            path,
          })
        }
      }
    }
    if (emitEvent) {
      const promise = this.observable.run({
        action: 'copy',
        type,
        updateStatus,
        oldpath,
        path
      })
      if (awaitEvent) await promise
    }
    return type
  }

  /**
   * Move an existing file or folder.
   */
  async _mv(
    oldpath,
    path,
    {
      deletion,
      emitEvent, awaitEvent,
      updateStatus,
      copyDelete,
      ignoreInodes,
      overwrite
    }={}
  ) {
    oldpath = normalizePath(oldpath)
    path = normalizePath(path)
    if (oldpath === path) {
      return
    } else if (!overwrite && await this.exists(path)) {
      throw new ExtError({
        code: 'DestinationExists',
        src: `fs:mv`,
        message: `Move operation failed due to target path "${path}" already exists.`,
        path
      })
    }
    const { _store, _inodes, _fs: fs } = this
    let type

    if (copyDelete) {
      type = await this._copy(oldpath, path, { overwrite })
      await this._rm(oldpath)
    } else {
      if (fs.supported && !isIDB(oldpath)) {
        type = await fs.mv(oldpath, path)
      } else {
        if (await this.exists(path)) {
          await this._rm(path, { ignoreInodes })
        }
        const dirpath = dirname(path)
        if (!(await this.exists(dirpath))) {
          await this._mkdir(dirpath, { emitEvent })
        }
        const file = await this.lookupFile(oldpath)
        if (file) {
          await _store.files.update(file.id, { path, mtimeMs: Date.now() })
          type = 'file'
        } else {
          const folder = await this.lookupFolder(oldpath)
          if (folder) {
            const mtimeMs = Date.now()
            await _store.files.where('path').startsWith(oldpath + '/').modify(file => {
              file.path = path + file.path.slice(oldpath.length)
              file.mtimeMs = mtimeMs
            })
            await _store.folders.where('path').startsWith(oldpath + '/').modify(folder => {
              folder.path = path + folder.path.slice(oldpath.length)
              folder.mtimeMs = mtimeMs
            })
            await _store.folders.update(folder.id, { path, mtimeMs })
            type = 'folder'
          } else {
            throw new ExtError({
              code: 'SourceNotFound',
              src: `fs:mv`,
              message: `Move operation failed due to source path "${oldpath}" missing.`,
              oldpath,
            })
          }
        }
      }
    }
    if (!ignoreInodes) {
      _inodes.rename(oldpath, path)
      if (type === 'folder') {
        _inodes.keys
          .filter(p => p.startsWith(oldpath + '/'))
          .forEach(p => _inodes.rename(p, p.replace(oldpath, path)))
      }
    }
    if (emitEvent) {
      const promise = this.observable.run({
        action: 'mv',
        updateStatus,
        oldpath,
        path,
        type,
        deletion
      })
      // Tricky: Can cause deadlocks! (Only needed in tests)
      if (awaitEvent) await promise
    }
    return {
      oldpath,
      path,
      type
    }
  }

  /**
   * Return the contents of a file if it exists, otherwise returns null Promise.
   */
  async read(filepath, options = {}) {
    return this.readFile(filepath, options).catch(() => null)
  }

  /**
   * Return the contents of a file if it exists, otherwise reject Promise.
   */
  async readFile(path, options = {}) {
    path = normalizePath(path)
    const {_fs: fs, _store} = this
    const encoding = options.encoding
    if (fs.supported && !isIDB(path)) {
      return fs.readFile(path, encoding)
    } else {
      const file = await this.lookupFile(path)
      if (file) {
        const data = await _store.data.get(file.fid)
        const text = (data && data.text) || ''
        const dataEncoding = (data && data.encoding) || ''
        if (dataEncoding) {
          if (encoding === 'utf8' && dataEncoding === 'utf8') {
            return text
          } else if (!encoding) {
            return Buffer.from(text, dataEncoding)
          } else {
            return Buffer.from(text, dataEncoding).toString(encoding)
          }
        } else {
          if (encoding === 'utf8') {
            return text
          } else if (encoding) {
            return Buffer.from(text).toString(encoding)
          } else {
            return Buffer.from(text)
          }
        }
      } else {
        throw new ExtError({
          code: 'FileNotFound',
          src: `fs:read`,
          message: `File not found "${path}".`,
          path
        })
      }
    }
  }

  /**
   * Make a directory (or series of nested directories) without throwing an error if it already exists.
   */
  async _mkdir(path, { recursive=false, emitEvent, awaitEvent }={}) {
    path = normalizePath(path)
    const { _fs: fs } = this
    let created
    if (fs.supported && !isIDB(path)) {
      if (recursive) {
        created = await fs.mkdirp(path)
      } else {
        created = await fs.mkdir(path)
      }
    } else {
      if (recursive) {
        const folders = path.split('/').map((name, index, array) => array.slice(0, index + 1).join('/'))
        for (let dirpath of folders) {
          const exists = await this.exists(dirpath)
          if (!exists) {
            try {
              const time = Date.now()
              await this._store.folders.put({
                id: uuid4(),
                path: dirpath,
                mtimeMs: time,
                ctimeMs: time
              })
              this._inodes.set(dirpath, this._ino++)
            } catch (e) {
              console.error(e)
            }
          }
        }
        created = await this.exists(path)
      } else {
        try {
          const time = Date.now()
          await this._store.folders.put({
            id: uuid4(),
            path,
            mtimeMs: time,
            ctimeMs: time
          })
          created = true
        } catch (e) {
          console.error(e)
        }
      }
    }
    if (created && emitEvent) {
      const promise = this.observable.run({
        action: 'mkdir',
        path,
        type: 'folder'
      })
      if (awaitEvent) await promise
    }
  }

  /**
   * Write a file (creating missing directories if need be) without throwing errors.
   */
  async _write(path, contents, { mode, target, mkdir, updateStatus, emitEvent, awaitEvent }={}) {
    path = normalizePath(path)
    contents = contents || ''
    const { _fs: fs, _store } = this

    const dir = dirname(path)
    if (mkdir && !(await this.exists(dir))) {
      await this._mkdir(dir, { recursive: true, emitEvent })
    }

    const binary = GitFileSystem.isArrayBuffer(contents)
    let mtimeMs, size
    if (fs.supported && !isIDB(path)) {
      ({mtimeMs, size, mode} = await fs.write(path, binary ? Buffer.from(contents).toString('base64') : contents, binary))
      if (emitEvent) {
        const promise = this.observable.run({
          action: 'write',
          path,
          type: 'file',
          updateStatus
        })
        if (awaitEvent) await promise
      }
    } else {
      const file = await this.lookupFile(path)
      const content = binary ? castAsReadableArrayBuffer(contents) : contents
      size = content.byteLength || content.length
      mtimeMs = Date.now()
      const ctimeMs = file ? file.ctimeMs : mtimeMs
      const fid = file ? file.id : uuid4()
      await _store.files.put({
        id: fid, fid,
        path, target,
        mode, size,
        ctimeMs, mtimeMs,
      })
      await _store.data.put({
        fid,
        text: content,
        encoding: binary ? 'binary' : 'utf8'
      })
      if (emitEvent) {
        const promise = this.observable.run({
          action: 'write',
          path,
          type: 'file',
          idb: true,
          target,
          mode,
          content,
          updateStatus
        })
        if (awaitEvent) await promise
      }
    }
    return { mode, mtimeMs, type: 'file', ino: 0, size }
  }

  /**
   * Delete a file without throwing an error if it is already deleted.
   */
  async _rm(path, { tmpDir, updateStatus, emitEvent, awaitEvent, ignoreInodes }={}) {
    path = normalizePath(path)
    const { _fs: fs, _store, _inodes } = this
    let removed = false
    if (tmpDir) {
      // Use a unique id to prevent collisions
      return this._mv(path, `${tmpDir}${path}~${uuid4()}`, { updateStatus, emitEvent, awaitEvent, deletion: true })
    } else {
      const stats = await this.lstat(path)
      if (stats) {
        if (stats.isDirectory()) {
          return this._rmdir(path, { updateStatus })
        } else {
          if (fs.supported && !isIDB(path)) {
            removed = await fs.remove(path)
          } else {
            const file = await _store.files.get({ path })  // Note, rm should not follow symlinks
            if (file) {
              await Promise.all([
                _store.files.delete(file.id),
                _store.data.delete(file.fid)
              ])
              removed = true
            }
          }
        }
      } else {
        removed = true
      }
    }
    if (!ignoreInodes) {
      _inodes.del(path)
    }
    if (removed) {
      if (emitEvent) {
        const promise = this.observable.run({
          action: 'rm',
          updateStatus,
          oldpath: path,
          path: null,
          type: 'file'
        })
        if (awaitEvent) await promise
      }
      return {
        oldpath: path,
        path: null,
        type: 'file'
      }
    } else {
      throw new ExtError({
        code: 'RemoveFailed',
        src: `fs:rm`,
        message: `Could not remove ${path}.`,
        path,
      })
    }
  }

  /**
   * Assume removing a directory.
   */
  async _rmdir(path, { tmpDir, updateStatus, emitEvent, awaitEvent }={}) {
    path = normalizePath(path)
    const { _inodes, _fs: fs, _store } = this
    const startPath = path + '/'
    _inodes.keys
      .filter(p => p === path || p.startsWith(startPath))
      .forEach(p => _inodes.del(p))
    if (tmpDir) {
      return this._mv(path, tmpDir + path, { updateStatus, deletion: true })
    } else {
      const stats = await this.lstat(path)
      let removed = false
      if (stats) {
        if (stats.isDirectory()) {
          if (fs.supported && !isIDB(path)) {
            removed = await fs.remove(path)
          } else {
            const files = _store.files.where('path').startsWith(startPath)
            const fids = (await files.toArray()).map(f => f.fid)
            await Promise.all([
              _store.folders.where('path').equals(path).delete(),
              files.delete(),
              _store.data.where('fid').anyOf(fids).delete(),
              _store.folders.where('path').startsWith(startPath).delete()
            ])
            removed = true
          }
        } else {
          throw new ExtError({
            code: 'NotADirectory',
            src: `fs:rmdir`,
            message: `${path} is not a directory.`,
            path,
            stats,
          })
        }
      } else {
        removed = true
      }
      if (removed) {
        if (emitEvent) {
          const promise = this.observable.run({
            action: 'rmdir',
            updateStatus,
            oldpath: path,
            path: null,
            type: 'folder'
          })
          if (awaitEvent) await promise
        }
        return {
          oldpath: path,
          path: null,
          type: 'folder'
        }
      } else {
        throw new ExtError({
          code: 'RemoveFailed',
          src: `fs:rmdir`,
          message: `Could not remove ${path}.`,
          path,
        })
      }
    }
  }

  /**
   * Count number of files under a directory (including files in subdirectories).
   */
  async fileCount(dirname) {
    const children = await this.readdirDeep(dirname, { files: true })
    return children ? children.length : null
  }

  /**
   * Read a directory without throwing an error is the directory doesn't exist
   */
  async readdir(path, { skipFiles = false, skipFolders = false }={}) {
    path = normalizePath(path)
    const {_fs: fs, _store} = this
    let paths
    if (fs.supported && !isIDB(path)) {
      paths = await fs.readdir(path, skipFiles, skipFolders)
      if (paths && paths.length) {
        return paths
      } else {
        return []
      }
    }
    const folder = await this.lookupFolder(path)
    if (folder) {
      const startPath = folder.path + '/'
      const l = startPath.length
      let foldersPromise = skipFolders ? [] : _store.folders.where('path').startsWith(startPath).filter(f => !f.path.slice(l).includes('/')).keys()
      let filesPromise = skipFiles ? [] : _store.files.where('path').startsWith(startPath).filter(f => !f.path.slice(l).includes('/')).keys()
      paths = (await foldersPromise).concat(await filesPromise).map(p => p.slice(l))
      return paths
    } else {
      return []
    }
  }

  /**
   * Return a flat list of all the files nested inside a directory
   */
  async readdirDeep(dirname, { files = true, folders = false, relative = false, ignoreName='' }={}) {
    const { _store, _fs: fs } = this
    dirname = normalizePath(dirname)
    const startPath = dirname + '/'
    const l = startPath.length
    let paths
    if (fs.supported && !isIDB(dirname)) {
      paths = await fs.readdirDeep(dirname, files, folders, ignoreName)
    } else {
      const [filesList, foldersList] = await Promise.all([
        files ? _store.files.where('path').startsWith(startPath).keys() : [],
        folders ? _store.folders.where('path').startsWith(startPath).keys() : []
      ])
      paths = foldersList.concat(filesList)
    }
    if (paths) {
      if (ignoreName) {
        const ignoreNames = new Set(ignoreName.split(':'))
        const ignoreRegex = new RegExp(`/(${ignoreName.replace(/:/g, '|').replace(/\./g, '\\.')})/`)
        paths = paths.filter(path => !ignoreRegex.test(path) && !ignoreNames.has(basename(path)))
      }
      if (relative) paths = paths.map(p => p.slice(l))
    }
    return paths
  }

  /**
   * Return the Stats of a file/symlink if it exists, otherwise returns null.
   * Rethrows errors that aren't related to file existance.
   */
  async lstat(path) {
    path = normalizePath(path)
    const {_store, _fs: fs} = this
    if (fs.supported && !isIDB(path)) {
      return await fs.lstat(path)
    } else {
      const file = await _store.files.get({ path })
      if (file) {
        if (file.target) {
          return new Stats({
            size: file.size || 0,
            mode: FileTypeModes.SYMLINK,
            mtimeMs: file.mtimeMs,
            ctimeMs: file.ctimeMs
          })
        } else {
          return new Stats({
            size: file.size || 0,
            mode: FileTypeModes.FILE,
            mtimeMs: file.mtimeMs,
            ctimeMs: file.ctimeMs
          })
        }
      } else {
        const folder = await _store.folders.get({ path })
        if (folder) {
          return new Stats({
            size: 0,
            mode: FileTypeModes.DIRECTORY,
            mtimeMs: folder.mtimeMs,
            ctimeMs: folder.ctimeMs
          })
        } else {
          return null
        }
      }
    }
  }

  /**
   * Return the file size of a file or 0 otherwise.
   */
  async size(path) {
    return ((await this.lstat(path)) || {size: 0}).size
  }

  /**
   * Reads the contents of a symlink if it exists, otherwise returns null.
   * Rethrows errors that aren't related to file existance.
   */
  async readlink(path) {
    path = normalizePath(path)
    const {_fs: fs, _store} = this
    if (fs.supported && !isIDB(path)) return fs.readlink(path)
    const file = await _store.files.get({ path })
    return (file && file.target) || null
  }

  /**
   * Write the contents of buffer to a symlink.
   */
  async _writelink(filepath, buffer) {
    filepath = normalizePath(filepath)
    const {_fs: fs} = this
    const dirpath = dirname(filepath)
    if (!this.exists(dirpath)) {
      await this._mkdir(dirpath)
    }
    const target = buffer.toString('utf8')
    if (fs.supported && !isIDB(filepath)) {
      return fs.writelink(filepath, target)
    } else {
      return this._write(filepath, '', { target, mode: FileTypeModes.SYMLINK })
    }
  }

  static isArrayBuffer(value) {
    return value instanceof ArrayBuffer || (value && value.buffer instanceof ArrayBuffer && value.byteLength !== undefined)
  }
}

var GitFileSystemClass = GitFileSystem
var GFS = new GitFileSystem(DFS)


function tryParseJSON(json) {
  try {
    return JSON.parse(json) || null
  } catch (e) {
    return null
  }
}

/**
 * Converts any buffer interface to an ArrayBuffer pointing to the same memory.
 * @param {Buffer|Uint8Array|ArrayBuffer} buf
 */
function castAsReadableArrayBuffer(buf) {
  if (buf instanceof ArrayBuffer) {
    return buf
  } else if (buf instanceof Uint8Array) {
    // Check if is a subarray
    if (buf.byteOffset === 0 && buf.byteLength === buf.buffer.byteLength) {
      return buf.buffer
    } else {
      // Return a copy of subarray
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
    }
  } else if (Buffer.isBuffer(buf)) {
    return buf.buffer
  } else {
    throw new Error('Argument type not recognized: ' + (typeof buf))
  }
}


class Environ {
  /**
   * Creates a file system wrapper for Git
   * @param {DeviceFileSystem} fs
   */
  constructor(fs) {
    this._fs = fs
    this.locale = 'en'
    this._nodeStoragePath = null
  }

  get locationSearch() {
    return window.location.search || ''
  }

  get locationPathname() {
    return window.location.pathname || '/'
  }

  queryVariable(variable, url) {
    const query = url ? url.split('?').pop() : this.locationSearch.substring(1);
    const vars = query.split('&');
    for (let i = 0; i < vars.length; i++) {
        let pair = vars[i].split('=');
        if (decodeURIComponent(pair[0]) == variable) {
            return decodeURIComponent(pair[1]);
        }
    }
  }

  get isDebugging() {
    return this.queryVariable('debug')
  }

  get sandboxUrl() {
    return window.location.origin.includes('localhost') ? 'http://localhost:8321' : 'https://run.spck.io'
  }

  get accountUrl() {
    return this.isDebugging ? 'http://localhost:8081' : 'https://account.spck.io/v3'
  }

  get apiUrl() {
    return this.isDebugging ? 'https://localhost' : 'https://api-v3.spck.io'
  }

  get siteUrl() {
    return 'https://spck.io'
  }

  setNodeJsModuleStoragePath(nodeStoragePath) {
    this._nodeStoragePath = nodeStoragePath
  }

  getNodeJsModuleStoragePath() {
    return this._nodeStoragePath
  }

  async getExternalFsDirsAsync() {
    const dirs = await this._fs.getExternalFsDirsAsync()
    if (dirs === null) {
      return null
    } else if (dirs && dirs.length) {
      dirs[0].name = 'External'
      dirs[0].value = 'external'
      dirs.slice(1, 3).forEach((dir, i) => {
        dir.name = `SD${i+1}`
        dir.value = `SD${i+1}`
      })
      return dirs
    } else {
      return []
    }
  }

  getInternalDir(path) {
    if (!this._internalDir) {
      this._internalDir = this._fs.supported ? this._fs.storageDir : 'idb'
    }
    return join(this._internalDir, path)
  }

  projectConfigPath(dir) {
    return join(dir, '.projects')
  }

  gitConfigPath() {
    return this.getInternalDir('.gitconfig')
  }

  preferencesPath() {
    return this.getInternalDir('.prefs')
  }

  settingsConfigPath() {
    return this.getInternalDir('.settings')
  }

  globalTasksConfigPath() {
    return this.getInternalDir('.metadata/.tasks/.global')
  }

  cachedUserDataPath() {
    return this.getInternalDir('.metadata/.user')
  }

  fontsDir() {
    return this.getInternalDir('.metadata/.fonts')
  }

  signatureDir() {
    return this.getInternalDir('.metadata/.sig')
  }

  projectTasksConfigPath(dir) {
    return join(`${dirname(dir)}/.metadata/.tasks`, basename(dir))
  }

  projectInfoPath(dir) {
    return join(`${dirname(dir)}/.metadata/.info`, basename(dir))
  }

  tmpDir(dir) {
    return join(`${dirname(dir)}/.tmp`, basename(dir))
  }

  metadataPath(dir) {
    return join(`${dirname(dir)}/.metadata`, basename(dir))
  }

  trashDir(dir) {
    return join(`${dirname(dir)}/.trash`, basename(dir))
  }
}

var ENV = new Environ(DFS)
/* exported GitFileSystemClass, GFS, ENV, DeviceFileSystemClass, PathUtils, ObservableClass */

class ExtError extends Error {
  constructor(args) {
    super(args.message)
    Object.assign(this, args)
    this.name = this.code
  }
}

const ERROR_SOURCE = 'filesystem'
const isIDB = path => path === 'idb' || path.startsWith('idb/')

const ext = (path) => {
  if (path === null) return null
  const tail = basename(path)
  const index = tail.lastIndexOf('.')
  return index == -1 ? '' : tail.substr(index).toLowerCase()
}

/**
 * Generates a random ID.
 */
const uuid4 = () => {
 // From http://stackoverflow.com/questions/105034/how-to-create-a-guid-uuid-in-javascript
 return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
   const r = Math.random() * 16 | 0
   const v = c === 'x' ? r : (r & 0x3 | 0x8)
   return v.toString(16)
 })
}

const normPathCache = new LFUCache(800, 0.8)
/**
 * Remove any '.' in the path. For example: 'Path/.' -> 'Path'
 * @param {string} path
 */
const normalizePath = (path) => {
  const cached = normPathCache.get(path)
  if (cached) return cached
  else {
    if (path.indexOf('\u0000') >= 0) {
      throw new ExtError({
        code: 'InvalidArgument',
        src: `${ERROR_SOURCE}:normalizePath`,
      })
    } else if (!path) {
      throw new ExtError({
        code: 'InvalidArgument',
        src: `${ERROR_SOURCE}:normalizePath`,
      })
    }
    return normPathCache.set(
      path,
      path.split('/')
        .filter((part, i) => (part !== '' || i === 0) && part !== '.')
        .join('/')
    )
  }
}

const dirname = (path) => {
  const last = path.lastIndexOf('/')
  if (last === -1) return '.'
  if (last === 0) return '/'
  return path.slice(0, last)
}

const relativeTo = (path, base) => {
  return base ? path.slice(base.length + (base.endsWith('/') ? 0 : 1)) : path
}

const childOf = (path, base) => {
  if (!path) return false
  path = normalizePath(path)
  base = normalizePath(base)
  return path.startsWith(base + '/') || path === base
}

const basename = (path) => {
  const last = path.lastIndexOf('/')
  if (last === -1) return path
  return path.slice(last + 1)
}

const hasExt = (path, extension) => {
  return path && ext(path) === extension
}

const join = (path1, path2) => {
  if (!path2) return path1
  else {
    return (path1 == null) ? null : (path1.replace(/\/$/, '') + '/' + path2.replace(/^\//, ''))
  }
}

const $warn = console ? console.warn : (() => { })

const FileType = {
  FILE: 0o100000,
  DIRECTORY: 0o40000,
  SYMLINK: 0o120000
}

class Stats {
  /**
   * Provides information about a particular entry in the file system.
   * @param args
   * @param args.size Size of the item in bytes. For directories/symlinks,
   *   this is normally the size of the struct that represents the item.
   * @param args.mode Unix-style file mode (e.g. 0o644)
   * @param args.atimeMs time of last access, in milliseconds since epoch
   * @param args.mtimeMs time of last modification, in milliseconds since epoch
   * @param args.ctimeMs time of last time file status was changed, in milliseconds since epoch
   */
  constructor({size, mode, atimeMs=null, mtimeMs, ctimeMs}) {
    let currentTime = Date.now()
    this.atimeMs = typeof atimeMs !== 'number' ? currentTime : atimeMs
    this.mtimeMs = typeof mtimeMs !== 'number' ? currentTime : mtimeMs
    this.ctimeMs = typeof ctimeMs !== 'number' ? currentTime : ctimeMs
    this.size = size
    this.mode = Stats.normalizeMode(mode)
    this.uid = this.gid = this.ino = 0
  }

  get atime() {
    return new Date(this.atimeMs)
  }

  get mtime() {
    return new Date(this.mtimeMs)
  }

  get ctime() {
    return new Date(this.ctimeMs)
  }

  toBuffer() {
    const buffer = Buffer.alloc(32)
    buffer.writeUInt32LE(this.size, 0)
    buffer.writeUInt32LE(this.mode, 4)
    buffer.writeDoubleLE(this.atimeMs, 8)
    buffer.writeDoubleLE(this.mtimeMs, 16)
    buffer.writeDoubleLE(this.ctimeMs, 24)
    return buffer
  }

  /**
   * @return [Boolean] True if this item is a file.
   */
  isFile() {
    return (this.mode & 0xF000) === FileType.FILE
  }

  /**
   * @return [Boolean] True if this item is a directory.
   */
  isDirectory() {
    return (this.mode & 0xF000) === FileType.DIRECTORY
  }

  /**
   * @return [Boolean] True if this item is a symbolic link (only valid through lstat)
   */
  isSymbolicLink() {
    return (this.mode & 0xF000) === FileType.SYMLINK
  }

  /**
   * Change the mode of the file. We use this helper function to prevent messing
   * up the type of the file, which is encoded in mode.
   */
  chmod(mode) {
    return (this.mode = (this.mode & 0xF000) | mode)
  }

  /**
   * From https://github.com/git/git/blob/master/Documentation/technical/index-format.txt
   *
   * 32-bit mode, split into (high to low bits)
   *
   *  4-bit object type
   *    valid values in binary are 1000 (regular file), 1010 (symbolic link)
   *    and 1110 (gitlink)
   *
   *  3-bit unused
   *
   *  9-bit unix permission. Only 0755 and 0644 are valid for regular files.
   *  Symbolic links and gitlinks have value 0 in this field.
   */
  static normalizeMode(mode) {
    // Note: BrowserFS will use -1 for 'unknown'
    // I need to make it non-negative for these bitshifts to work.
    let type = mode > 0 ? mode >> 12 : 0
    // If it isn't valid, assume it as a 'regular file'
    // 0100 = directory
    // 1000 = regular file
    // 1010 = symlink
    // 1110 = gitlink
    if (
      type !== 4 &&
      type !== 8 &&
      type !== 10 &&
      type !== 14
    ) {
      type = 8
    }
    let permissions = mode & 511
    // Is the file executable? then 755. Else 644.
    if (permissions & 73) {
      permissions = 493
    } else {
      permissions = 420
    }
    // If it's not a regular file, scrub all permissions
    if (type !== 8) permissions = 0
    return (type << 12) + permissions
  }
}

const messageHandlers  = window.webkit && window.webkit.messageHandlers
if (messageHandlers && messageHandlers.file && messageHandlers.system) {
  const IOS_DOCUMENTS_DIR = '/documents/'
  class IOSAdapter {
    constructor({file, system}) {
      this._file = file
      this._system = system
      this._id = 1
      this._callbacks = {}
      this._serverRoot = null
      this.isIOS = true
    }

    async initServer() {
      this.serverUrl = await this.call(this._system, 'initServer')
    }

    launchWebView(url) {
      this._system.postMessage({method: 'launchWebView', url})
    }

    setConsole(value) {
      this._system.postMessage({method: 'setConsole', value})
    }

    getConsole() {
      return this.call(this._system, 'getConsole')
    }

    copyText(value) {
      this._system.postMessage({method: 'copyText', value})
    }

    appVersion() {
      return this.call(this._system, 'appVersion')
    }

    sdkVersion() {
      return 0
    }

    isTablet() {
      return this.call(this._system, 'isTablet')
    }

    versionName() {
      return this.call(this._system, 'versionName')
    }

    async clipboardText() {
      const {contents} = await this.call(this._system, 'clipboardText')
      return contents
    }

    getUrlFor(path) {
      if (!this.serverUrl) {
        throw new Error('IOS Server uninitialized: call initServer first')
      } else {
        return join(this.serverUrl, path)
      }
    }

    async setServerDir(path) {
      path = this._path(path)
      const success = await this.call(this._system, 'setServerDir', {path})
      if (success) {
        this._serverRoot = path
      } else {
        throw new ExtError({
          code: 'ServerFailError',
          message: 'Fail to configure server.'
        })
      }
    }

    // FileSystem

    async getFileContent() {
      const {contents} = await DeviceFileSystem.promisifyStatus(await this.call(this._file, 'getFileContent'))
      return contents
    }

    writeExternal(path, contents, base64) {
      return this.call(this._file, 'writeExternal', {path, contents, base64})
    }

    getStorageDir() {
      return IOS_DOCUMENTS_DIR
    }

    _path(path) {
      return path.slice(11)
    }

    mkdirp(path) {
      return this.call(this._file, 'mkdirp', {path: this._path(path)})
    }

    exists(path) {
      return this.call(this._file, 'exists', {path: this._path(path)})
    }

    readFile(path, encoding) {
      return this.call(this._file, 'readFile', {path: this._path(path), encoding})
    }

    remove(path) {
      return this.call(this._file, 'remove', {path: this._path(path)})
    }

    readlink(path) {
      return this.call(this._file, 'readlink', {path: this._path(path)})
    }

    writelink(path, target) {
      return this.call(this._file, 'writelink', {path: this._path(path), target})
    }

    write(path, contents, base64) {
      return this.call(this._file, 'write', {path: this._path(path), contents, base64})
    }

    readdir(path, skipFiles, skipFolders) {
      return this.call(this._file, 'readdir', {path: this._path(path), skipFiles, skipFolders})
    }

    gitHashObject(type, path) {
      return this.call(this._file, 'gitHashObject', {path: this._path(path), type})
    }

    readdirDeep(path, files, folders, ignoreName='') {
      return this.call(this._file, 'readdirDeep', {path: this._path(path), files, folders, ignoreName})
    }

    lstat(path) {
      return this.call(this._file, 'lstat', {path: this._path(path)})
    }

    mv(src, target) {
      return this.call(this._file, 'mv', {src: this._path(src), target: this._path(target)})
    }

    saveBase64(contents, name) {
      return this.call(this._file, 'saveBase64', {contents, name})
    }

    // Utils

    call(handler, propName, args) {
      args = args || {}
      const id = this._id++
      handler.postMessage(Object.assign({method: propName, id}, args))
      return new Promise((resolve, reject) => {
        this._callbacks[id] = {resolve, reject}
      })
    }

    send(id, args) {
      const fn = this._callbacks[id]
      if (fn) {
        delete this._callbacks[id]
        fn.resolve(args)
      }
    }

    sendError(id, args) {
      const fn = this._callbacks[id]
      if (fn) {
        fn.reject(args)
        delete this._callbacks[id]
      }
    }
  }
  window.Android = window.IOSBridge = new IOSAdapter(messageHandlers)
}


class Observable {
  constructor() {
    this._subscriptions = []
  }

  /**
   * Run all subscriptions with the provided args.
   */
  async run(args) {
    for (let func of this._subscriptions) {
      await func(args)
    }
  }

  /**
   * Subscribe to changes.
   */
  subscribe(fn) {
    this._subscriptions.push(fn)
    return {
      unsubscribe: () => {
        const subs = this._subscriptions
        if (subs.includes(fn)) subs.splice(subs.indexOf(fn), 1)
      }
    }
  }
}
var ObservableClass = Observable


class DeviceFileSystem {
  constructor(device) {
    // Does some checks to make sure Android interface matches expectations
    this.device = device
    this._legacy = null

    if (!device) {
      this._supported = false
    } else {
      this._supported = !!(device.mkdirp && device.exists
        && device.readFile && device.remove && device.readlink && device.writelink
        && device.write && device.readdir && device.readdirDeep && device.lstat
        && device.mv)
    }

    if (!this._supported) {
      $warn('DeviceFileSystem is not operational: interface missing')
    }
  }

  get supported() {
    return this._supported
  }

  get copySupported() {
    return this._supported && !!this.device.copy
  }

  get gitHashSupported() {
    return this._supported && !!this.device.gitHashObject
  }

  get externalFsSupported() {
    return this._supported && !!this.device.getAvailableExternalFilesDirs
  }

  get storageDir() {
    if (this._directory) {
      return this._directory
    } else {
      const device = this.device
      this._directory = device.getStorageDir ? device.getStorageDir() : '~/'
      return this._directory
    }
  }

  async getExternalFsDirsAsync() {
    if (this.externalFsSupported) {
      try {
        return DeviceFileSystem.promisifyStatus(await this.device.getAvailableExternalFilesDirs())
      } catch (e) {
        return null
      }
    } else {
      return null
    }
  }

  async gitHashObject(type, path) {
    const { contents } = await DeviceFileSystem.promisifyStatus(await this.device.gitHashObject(type, path))
    return contents
  }

  async copy(oldpath, path) {
    const { contents } = await DeviceFileSystem.promisifyStatus(await this.device.copy(oldpath, path))
    return contents
  }

  async readFile(path, encoding) {
    const { contents } = await DeviceFileSystem.promisifyStatus(await this.device.readFile(path, encoding))
    if (encoding === 'utf8' || encoding === 'base64') {
      return contents
    } else {
      return Buffer.from(contents, 'base64')
    }
  }

  async remove(path) {
    if (path === this.storageDir) {
      throw new ExtError({
        code: 'CriticalDeletionError',
        src: `fs:remove`,
        message: 'Critical deletion error.',
      })
    } else {
      return DeviceFileSystem.promisifyStatus(await this.device.remove(path))
    }
  }

  async readlink(path) {
    const { contents } = await DeviceFileSystem.promisifyStatus(await this.device.readlink(path))
    return contents
  }

  async writelink(path, target) {
    try {
      return (await DeviceFileSystem.promisifyStatus(await this.device.writelink(path, target)))
    } catch (e) {
      throw new ExtError({
        code: 'SymlinkWriteError',
        path,
        target
      })
    }
  }

  async write(path, contents, base64) {
    return DeviceFileSystem.promisifyStatus(await this.device.write(path, contents, !!base64))
  }

  async exists(path) {
    return this.device.exists(path)
  }

  async mkdirp(path) {
    const { contents } = await DeviceFileSystem.promisifyStatus(await this.device.mkdirp(path))
    return contents
  }

  async mkdir(path) {
    const { contents } = await DeviceFileSystem.promisifyStatus(await this.device.mkdir(path))
    return contents
  }

  async readdir(path, skipFiles, skipFolders) {
    try {
      const result = await DeviceFileSystem.promisifyStatus(
        await this.device.readdir(path, skipFiles, skipFolders)
      )
      return result
    } catch (e) {
      return null
    }
  }

  async readdirDeep(path, files, folders, ignoreName) {
    try {
      return DeviceFileSystem.promisifyStatus(await this.device.readdirDeep(path, files, folders, ignoreName))
    } catch (e) {
      return []
    }
  }

  async lstat(path) {
    try {
      return new Stats(DeviceFileSystem.normalizeStats(await DeviceFileSystem.promisifyStatus(await this.device.lstat(path))))
    } catch (e) {
      return null
    }
  }

  async mv(oldpath, path) {
    const { contents } = await DeviceFileSystem.promisifyStatus(await this.device.mv(oldpath, path))
    return contents
  }

  async writeExternal(uri, content, base64) {
    const device = this.device
    if (device && device.writeExternal) {
      return DeviceFileSystem.promisifyStatus(await device.writeExternal(uri, content, !!base64))
    }
  }

  static async promisifyStatus(json) {
    switch (json) {
      case '{}': {
        return {}
      }
      case '[]': {
        return []
      }
      default: {
        const data = tryParseJSON(json)
        if (data && data.status) {
          throw new ExtError(data)
        } else {
          return data
        }
      }
    }
  }

  static normalizeStats(stats) {
    // Prior to version 3.0.3, version-code 22, there was a bug where mtimeMs was actually in seconds
    const st_mtime = stats.st_mtime || stats.mtimeMs
    const st_ctime = stats.st_ctime || stats.ctimeMs
    const st_atime = stats.st_atime || stats.atimeMs
    Object.assign(stats, {
      mtimeMs: st_mtime * 1000,
      ctimeMs: st_ctime * 1000,
      atimeMs: st_atime * 1000
    })
    return stats
  }
}


var DeviceFileSystemClass = DeviceFileSystem
var DFS = new DeviceFileSystem(window.Android)

var PathUtils = {
  uuid4,
  isIDB,
  ext,
  hasExt,
  dirname,
  basename,
  join,
  relativeTo,
  childOf,
  normalizePath
}

const FileTypeModes = {
  FILE: 0o100644,
  DIRECTORY: 0o40000,
  SYMLINK: 0o120000
}

class GitFileSystem {
  /**
   * Creates a file system wrapper for Git
   * @param {DeviceFileSystem} fs
   */
  constructor (fs) {
    this._store = IDB,
    // DO NOT try to evict anything as this is just a regular store with a max size!
    this._inodes = new LFUCache(1e7, 0)
    this._ino = 1  // Counter

    this._fs = fs
    this.observable = new ObservableClass()
    const scheduleCache = Object.create(null)
    this._scheduleCache = scheduleCache
    // Tricky: Only use these functions externally to prevent deadlock (do not use within this class)
    const echo = path => path
    this.write = SingleThreadScheduler(this._write, echo, scheduleCache)
    this.mkdir = SingleThreadScheduler(this._mkdir, echo, scheduleCache)
    this.writelink = SingleThreadScheduler(this._writelink, echo, scheduleCache)
    this.mv = SingleThreadScheduler(this._mv, echo, scheduleCache)
    this.rm = SingleThreadScheduler(this._rm, echo, scheduleCache)
    this.rmdir = SingleThreadScheduler(this._rmdir, echo, scheduleCache)
    this.copy = SingleThreadScheduler(this._copy, echo, scheduleCache)
    // Git optimization for Android (calculate hashes in native Android code)
    this.gitHashObject = fs.gitHashSupported ? fs.gitHashObject.bind(fs) : null
  }

  clearCache() {
    this._inodes.clear()
    this._ino = 1
  }

  async safeWrite(path, content, tmpDir) {
    const tmpPath = join(tmpDir, path)
    await this.write(tmpPath, content)
    await this.mv(tmpPath, path, { overwrite: true, ignoreInodes: true })
  }

  async writeExternal(uri, content, base64) {
    const fs = this._fs
    return (fs.supported && await fs.writeExternal(uri, content, base64))
  }

  isBinaryContent(content) {
    return content && Buffer.from(content.slice(0, 8000)).some(value => value === 0)
  }

  /**
   * Create an unique identifier for a file, that stays the same thru renames.
   */
  inode(path, renew) {
    const inodes = this._inodes
    return (!renew && inodes.get(path)) || inodes.set(path, this._ino++)
  }

  /**
   * Special sync version for events that can't                      be async.
   */
  inodePath(inode) {
    return inode ? this._inodes.find(inode) : null
  }

  /**
   * Return true if a file exists, false if it doesn't exist.
   * Rethrows errors that aren't related to file existence.
   */
  async exists(path) {
    path = normalizePath(path)
    const { _store, _fs: fs, _inodes: inodes } = this
    if (inodes.get(path)) {
      return true
    } else {
      if (fs.supported && !isIDB(path)) {
        const exists = await fs.exists(path)
        if (exists) {
          // Create cached inode for faster existence lookup
          inodes.set(path, this._ino++)
        }
        return exists
      } else {
        const exists = !!(await _store.files.get({ path })) || !!(await _store.folders.get({ path }))
        if (exists) inodes.set(path, this._ino++)
        return exists
      }
    }
  }

  async lookupFolder(path) {
    const {_store} = this
    const folder = await _store.folders.get({ path })
    if (folder) {
      return folder
    } else {
      const target = await this.readlink(path)
      if (target && target !== path) {
        return (await this.lookupFolder(target))
      } else {
        return null
      }
    }
  }

  async lookupFile(path) {
    const file = await this._store.files.get({ path })
    if (file) {
      if (file.target && file.target !== path) {
        return (await this.lookupFile(file.target))
      } else {
        return file
      }
    } else {
      return null
    }
  }

  async _copy(
    oldpath,
    path,
    { updateStatus, emitEvent, awaitEvent, overwrite }={}
  ) {
    const {_fs: fs} = this
    const code = `${isIDB(oldpath) ? 'I' : 'F'}${isIDB(path) ? 'I' : 'F'}`
    let type
    switch (code) {
      case 'IF':
      case 'FI': {
        throw new ExtError({
          code: 'OperationNotSupported',
          src: `fs:copy`,
          message: 'Moving between IndexedDB and FileSystem is currently not supported!',
          path,
        })
      }
      case 'II': {
        if (await this.exists(path)) {
          if (overwrite) {
            await this._rm(path)
          } else {
            throw new ExtError({
              code: 'DestinationExists',
              src: `fs:copy`,
              message: `Copy operation failed due to target path "${path}" already exists.`,
              path
            })
          }
        }
        const file = await this.lookupFile(oldpath)
        if (file) {
          const filepath = file.path
          const contents = await this.read(filepath)
          await this.write(filepath.replace(oldpath, path), contents)
          type = 'file'
          break
        } else {
          const [files, folders] = await Promise.all([
            this.readdirDeep(oldpath, {files: true, folders: false}),
            this.readdirDeep(oldpath, {files: false, folders: true})
          ])
          folders.unshift(oldpath)
          for (let folder of folders) {
            await this._mkdir(folder.replace(oldpath, path))
          }
          for (let filepath of files) {
            await this.write(filepath.replace(oldpath, path), await this.read(filepath))
          }
          type = 'folder'
          break
        }
      }
      case 'FF': {
        if (fs.copySupported) {
          type = await fs.copy(oldpath, path)
          break
        } else {
          throw new ExtError({
            code: 'OperationNotSupported',
            src: `fs:copy`,
            message: 'Copy operation not supported by your system.',
            path,
          })
        }
      }
    }
    if (emitEvent) {
      const promise = this.observable.run({
        action: 'copy',
        type,
        updateStatus,
        oldpath,
        path
      })
      if (awaitEvent) await promise
    }
    return type
  }

  /**
   * Move an existing file or folder.
   */
  async _mv(
    oldpath,
    path,
    {
      deletion,
      emitEvent, awaitEvent,
      updateStatus,
      copyDelete,
      ignoreInodes,
      overwrite
    }={}
  ) {
    oldpath = normalizePath(oldpath)
    path = normalizePath(path)
    if (oldpath === path) {
      return
    } else if (!overwrite && await this.exists(path)) {
      throw new ExtError({
        code: 'DestinationExists',
        src: `fs:mv`,
        message: `Move operation failed due to target path "${path}" already exists.`,
        path
      })
    }
    const { _store, _inodes, _fs: fs } = this
    let type

    if (copyDelete) {
      type = await this._copy(oldpath, path, { overwrite })
      await this._rm(oldpath)
    } else {
      if (fs.supported && !isIDB(oldpath)) {
        type = await fs.mv(oldpath, path)
      } else {
        if (await this.exists(path)) {
          await this._rm(path, { ignoreInodes })
        }
        const dirpath = dirname(path)
        if (!(await this.exists(dirpath))) {
          await this._mkdir(dirpath, { emitEvent })
        }
        const file = await this.lookupFile(oldpath)
        if (file) {
          await _store.files.update(file.id, { path, mtimeMs: Date.now() })
          type = 'file'
        } else {
          const folder = await this.lookupFolder(oldpath)
          if (folder) {
            const mtimeMs = Date.now()
            await _store.files.where('path').startsWith(oldpath + '/').modify(file => {
              file.path = path + file.path.slice(oldpath.length)
              file.mtimeMs = mtimeMs
            })
            await _store.folders.where('path').startsWith(oldpath + '/').modify(folder => {
              folder.path = path + folder.path.slice(oldpath.length)
              folder.mtimeMs = mtimeMs
            })
            await _store.folders.update(folder.id, { path, mtimeMs })
            type = 'folder'
          } else {
            throw new ExtError({
              code: 'SourceNotFound',
              src: `fs:mv`,
              message: `Move operation failed due to source path "${oldpath}" missing.`,
              oldpath,
            })
          }
        }
      }
    }
    if (!ignoreInodes) {
      _inodes.rename(oldpath, path)
      if (type === 'folder') {
        _inodes.keys
          .filter(p => p.startsWith(oldpath + '/'))
          .forEach(p => _inodes.rename(p, p.replace(oldpath, path)))
      }
    }
    if (emitEvent) {
      const promise = this.observable.run({
        action: 'mv',
        updateStatus,
        oldpath,
        path,
        type,
        deletion
      })
      // Tricky: Can cause deadlocks! (Only needed in tests)
      if (awaitEvent) await promise
    }
    return {
      oldpath,
      path,
      type
    }
  }

  /**
   * Return the contents of a file if it exists, otherwise returns null Promise.
   */
  async read(filepath, options = {}) {
    return this.readFile(filepath, options).catch(() => null)
  }

  /**
   * Return the contents of a file if it exists, otherwise reject Promise.
   */
  async readFile(path, options = {}) {
    path = normalizePath(path)
    const {_fs: fs, _store} = this
    const encoding = options.encoding
    if (fs.supported && !isIDB(path)) {
      return fs.readFile(path, encoding)
    } else {
      const file = await this.lookupFile(path)
      if (file) {
        const data = await _store.data.get(file.fid)
        const text = (data && data.text) || ''
        const dataEncoding = (data && data.encoding) || ''
        if (dataEncoding) {
          if (encoding === 'utf8' && dataEncoding === 'utf8') {
            return text
          } else if (!encoding) {
            return Buffer.from(text, dataEncoding)
          } else {
            return Buffer.from(text, dataEncoding).toString(encoding)
          }
        } else {
          if (encoding === 'utf8') {
            return text
          } else if (encoding) {
            return Buffer.from(text).toString(encoding)
          } else {
            return Buffer.from(text)
          }
        }
      } else {
        throw new ExtError({
          code: 'FileNotFound',
          src: `fs:read`,
          message: `File not found "${path}".`,
          path
        })
      }
    }
  }

  /**
   * Make a directory (or series of nested directories) without throwing an error if it already exists.
   */
  async _mkdir(path, { recursive=false, emitEvent, awaitEvent }={}) {
    path = normalizePath(path)
    const { _fs: fs } = this
    let created
    if (fs.supported && !isIDB(path)) {
      if (recursive) {
        created = await fs.mkdirp(path)
      } else {
        created = await fs.mkdir(path)
      }
    } else {
      if (recursive) {
        const folders = path.split('/').map((name, index, array) => array.slice(0, index + 1).join('/'))
        for (let dirpath of folders) {
          const exists = await this.exists(dirpath)
          if (!exists) {
            try {
              const time = Date.now()
              await this._store.folders.put({
                id: uuid4(),
                path: dirpath,
                mtimeMs: time,
                ctimeMs: time
              })
              this._inodes.set(dirpath, this._ino++)
            } catch (e) {
              console.error(e)
            }
          }
        }
        created = await this.exists(path)
      } else {
        try {
          const time = Date.now()
          await this._store.folders.put({
            id: uuid4(),
            path,
            mtimeMs: time,
            ctimeMs: time
          })
          created = true
        } catch (e) {
          console.error(e)
        }
      }
    }
    if (created && emitEvent) {
      const promise = this.observable.run({
        action: 'mkdir',
        path,
        type: 'folder'
      })
      if (awaitEvent) await promise
    }
  }

  /**
   * Write a file (creating missing directories if need be) without throwing errors.
   */
  async _write(path, contents, { mode, target, mkdir, updateStatus, emitEvent, awaitEvent }={}) {
    path = normalizePath(path)
    contents = contents || ''
    const { _fs: fs, _store } = this

    const dir = dirname(path)
    if (mkdir && !(await this.exists(dir))) {
      await this._mkdir(dir, { recursive: true, emitEvent })
    }

    const binary = GitFileSystem.isArrayBuffer(contents)
    let mtimeMs, size
    if (fs.supported && !isIDB(path)) {
      ({mtimeMs, size, mode} = await fs.write(path, binary ? Buffer.from(contents).toString('base64') : contents, binary))
      if (emitEvent) {
        const promise = this.observable.run({
          action: 'write',
          path,
          type: 'file',
          updateStatus
        })
        if (awaitEvent) await promise
      }
    } else {
      const file = await this.lookupFile(path)
      const content = binary ? castAsReadableArrayBuffer(contents) : contents
      size = content.byteLength || content.length
      mtimeMs = Date.now()
      const ctimeMs = file ? file.ctimeMs : mtimeMs
      const fid = file ? file.id : uuid4()
      await _store.files.put({
        id: fid, fid,
        path, target,
        mode, size,
        ctimeMs, mtimeMs,
      })
      await _store.data.put({
        fid,
        text: content,
        encoding: binary ? 'binary' : 'utf8'
      })
      if (emitEvent) {
        const promise = this.observable.run({
          action: 'write',
          path,
          type: 'file',
          idb: true,
          target,
          mode,
          content,
          updateStatus
        })
        if (awaitEvent) await promise
      }
    }
    return { mode, mtimeMs, type: 'file', ino: 0, size }
  }

  /**
   * Delete a file without throwing an error if it is already deleted.
   */
  async _rm(path, { tmpDir, updateStatus, emitEvent, awaitEvent, ignoreInodes }={}) {
    path = normalizePath(path)
    const { _fs: fs, _store, _inodes } = this
    let removed = false
    if (tmpDir) {
      // Use a unique id to prevent collisions
      return this._mv(path, `${tmpDir}${path}~${uuid4()}`, { updateStatus, emitEvent, awaitEvent, deletion: true })
    } else {
      const stats = await this.lstat(path)
      if (stats) {
        if (stats.isDirectory()) {
          return this._rmdir(path, { updateStatus })
        } else {
          if (fs.supported && !isIDB(path)) {
            removed = await fs.remove(path)
          } else {
            const file = await _store.files.get({ path })  // Note, rm should not follow symlinks
            if (file) {
              await Promise.all([
                _store.files.delete(file.id),
                _store.data.delete(file.fid)
              ])
              removed = true
            }
          }
        }
      } else {
        removed = true
      }
    }
    if (!ignoreInodes) {
      _inodes.del(path)
    }
    if (removed) {
      if (emitEvent) {
        const promise = this.observable.run({
          action: 'rm',
          updateStatus,
          oldpath: path,
          path: null,
          type: 'file'
        })
        if (awaitEvent) await promise
      }
      return {
        oldpath: path,
        path: null,
        type: 'file'
      }
    } else {
      throw new ExtError({
        code: 'RemoveFailed',
        src: `fs:rm`,
        message: `Could not remove ${path}.`,
        path,
      })
    }
  }

  /**
   * Assume removing a directory.
   */
  async _rmdir(path, { tmpDir, updateStatus, emitEvent, awaitEvent }={}) {
    path = normalizePath(path)
    const { _inodes, _fs: fs, _store } = this
    const startPath = path + '/'
    _inodes.keys
      .filter(p => p === path || p.startsWith(startPath))
      .forEach(p => _inodes.del(p))
    if (tmpDir) {
      return this._mv(path, tmpDir + path, { updateStatus, deletion: true })
    } else {
      const stats = await this.lstat(path)
      let removed = false
      if (stats) {
        if (stats.isDirectory()) {
          if (fs.supported && !isIDB(path)) {
            removed = await fs.remove(path)
          } else {
            const files = _store.files.where('path').startsWith(startPath)
            const fids = (await files.toArray()).map(f => f.fid)
            await Promise.all([
              _store.folders.where('path').equals(path).delete(),
              files.delete(),
              _store.data.where('fid').anyOf(fids).delete(),
              _store.folders.where('path').startsWith(startPath).delete()
            ])
            removed = true
          }
        } else {
          throw new ExtError({
            code: 'NotADirectory',
            src: `fs:rmdir`,
            message: `${path} is not a directory.`,
            path,
            stats,
          })
        }
      } else {
        removed = true
      }
      if (removed) {
        if (emitEvent) {
          const promise = this.observable.run({
            action: 'rmdir',
            updateStatus,
            oldpath: path,
            path: null,
            type: 'folder'
          })
          if (awaitEvent) await promise
        }
        return {
          oldpath: path,
          path: null,
          type: 'folder'
        }
      } else {
        throw new ExtError({
          code: 'RemoveFailed',
          src: `fs:rmdir`,
          message: `Could not remove ${path}.`,
          path,
        })
      }
    }
  }

  /**
   * Count number of files under a directory (including files in subdirectories).
   */
  async fileCount(dirname) {
    const children = await this.readdirDeep(dirname, { files: true })
    return children ? children.length : null
  }

  /**
   * Read a directory without throwing an error is the directory doesn't exist
   */
  async readdir(path, { skipFiles = false, skipFolders = false }={}) {
    path = normalizePath(path)
    const {_fs: fs, _store} = this
    let paths
    if (fs.supported && !isIDB(path)) {
      paths = await fs.readdir(path, skipFiles, skipFolders)
      if (paths && paths.length) {
        return paths
      } else {
        return []
      }
    }
    const folder = await this.lookupFolder(path)
    if (folder) {
      const startPath = folder.path + '/'
      const l = startPath.length
      let foldersPromise = skipFolders ? [] : _store.folders.where('path').startsWith(startPath).filter(f => !f.path.slice(l).includes('/')).keys()
      let filesPromise = skipFiles ? [] : _store.files.where('path').startsWith(startPath).filter(f => !f.path.slice(l).includes('/')).keys()
      paths = (await foldersPromise).concat(await filesPromise).map(p => p.slice(l))
      return paths
    } else {
      return []
    }
  }

  /**
   * Return a flat list of all the files nested inside a directory
   */
  async readdirDeep(dirname, { files = true, folders = false, relative = false, ignoreName='' }={}) {
    const { _store, _fs: fs } = this
    dirname = normalizePath(dirname)
    const startPath = dirname + '/'
    const l = startPath.length
    let paths
    if (fs.supported && !isIDB(dirname)) {
      paths = await fs.readdirDeep(dirname, files, folders, ignoreName)
    } else {
      const [filesList, foldersList] = await Promise.all([
        files ? _store.files.where('path').startsWith(startPath).keys() : [],
        folders ? _store.folders.where('path').startsWith(startPath).keys() : []
      ])
      paths = foldersList.concat(filesList)
    }
    if (paths) {
      if (ignoreName) {
        const ignoreNames = new Set(ignoreName.split(':'))
        const ignoreRegex = new RegExp(`/(${ignoreName.replace(/:/g, '|').replace(/\./g, '\\.')})/`)
        paths = paths.filter(path => !ignoreRegex.test(path) && !ignoreNames.has(basename(path)))
      }
      if (relative) paths = paths.map(p => p.slice(l))
    }
    return paths
  }

  /**
   * Return the Stats of a file/symlink if it exists, otherwise returns null.
   * Rethrows errors that aren't related to file existance.
   */
  async lstat(path) {
    path = normalizePath(path)
    const {_store, _fs: fs} = this
    if (fs.supported && !isIDB(path)) {
      return await fs.lstat(path)
    } else {
      const file = await _store.files.get({ path })
      if (file) {
        if (file.target) {
          return new Stats({
            size: file.size || 0,
            mode: FileTypeModes.SYMLINK,
            mtimeMs: file.mtimeMs,
            ctimeMs: file.ctimeMs
          })
        } else {
          return new Stats({
            size: file.size || 0,
            mode: FileTypeModes.FILE,
            mtimeMs: file.mtimeMs,
            ctimeMs: file.ctimeMs
          })
        }
      } else {
        const folder = await _store.folders.get({ path })
        if (folder) {
          return new Stats({
            size: 0,
            mode: FileTypeModes.DIRECTORY,
            mtimeMs: folder.mtimeMs,
            ctimeMs: folder.ctimeMs
          })
        } else {
          return null
        }
      }
    }
  }

  /**
   * Return the file size of a file or 0 otherwise.
   */
  async size(path) {
    return ((await this.lstat(path)) || {size: 0}).size
  }

  /**
   * Reads the contents of a symlink if it exists, otherwise returns null.
   * Rethrows errors that aren't related to file existance.
   */
  async readlink(path) {
    path = normalizePath(path)
    const {_fs: fs, _store} = this
    if (fs.supported && !isIDB(path)) return fs.readlink(path)
    const file = await _store.files.get({ path })
    return (file && file.target) || null
  }

  /**
   * Write the contents of buffer to a symlink.
   */
  async _writelink(filepath, buffer) {
    filepath = normalizePath(filepath)
    const {_fs: fs} = this
    const dirpath = dirname(filepath)
    if (!this.exists(dirpath)) {
      await this._mkdir(dirpath)
    }
    const target = buffer.toString('utf8')
    if (fs.supported && !isIDB(filepath)) {
      return fs.writelink(filepath, target)
    } else {
      return this._write(filepath, '', { target, mode: FileTypeModes.SYMLINK })
    }
  }

  static isArrayBuffer(value) {
    return value instanceof ArrayBuffer || (value && value.buffer instanceof ArrayBuffer && value.byteLength !== undefined)
  }
}

var GitFileSystemClass = GitFileSystem
var GFS = new GitFileSystem(DFS)


function tryParseJSON(json) {
  try {
    return JSON.parse(json) || null
  } catch (e) {
    return null
  }
}

/**
 * Converts any buffer interface to an ArrayBuffer pointing to the same memory.
 * @param {Buffer|Uint8Array|ArrayBuffer} buf
 */
function castAsReadableArrayBuffer(buf) {
  if (buf instanceof ArrayBuffer) {
    return buf
  } else if (buf instanceof Uint8Array) {
    // Check if is a subarray
    if (buf.byteOffset === 0 && buf.byteLength === buf.buffer.byteLength) {
      return buf.buffer
    } else {
      // Return a copy of subarray
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
    }
  } else if (Buffer.isBuffer(buf)) {
    return buf.buffer
  } else {
    throw new Error('Argument type not recognized: ' + (typeof buf))
  }
}


class Environ {
  /**
   * Creates a file system wrapper for Git
   * @param {DeviceFileSystem} fs
   */
  constructor(fs) {
    this._fs = fs
    this.locale = 'en'
    this._nodeStoragePath = null
  }

  get locationSearch() {
    return window.location.search || ''
  }

  get locationPathname() {
    return window.location.pathname || '/'
  }

  queryVariable(variable, url) {
    const query = url ? url.split('?').pop() : this.locationSearch.substring(1);
    const vars = query.split('&');
    for (let i = 0; i < vars.length; i++) {
        let pair = vars[i].split('=');
        if (decodeURIComponent(pair[0]) == variable) {
            return decodeURIComponent(pair[1]);
        }
    }
  }

  get isDebugging() {
    return this.queryVariable('debug')
  }

  get sandboxUrl() {
    return window.location.origin.includes('localhost') ? 'http://localhost:8321' : 'https://run.spck.io'
  }

  get accountUrl() {
    return this.isDebugging ? 'http://localhost:8081' : 'https://account.spck.io/v3'
  }

  get apiUrl() {
    return this.isDebugging ? 'https://localhost' : 'https://api-v3.spck.io'
  }

  get siteUrl() {
    return 'https://spck.io'
  }

  setNodeJsModuleStoragePath(nodeStoragePath) {
    this._nodeStoragePath = nodeStoragePath
  }

  getNodeJsModuleStoragePath() {
    return this._nodeStoragePath
  }

  async getExternalFsDirsAsync() {
    const dirs = await this._fs.getExternalFsDirsAsync()
    if (dirs === null) {
      return null
    } else if (dirs && dirs.length) {
      dirs[0].name = 'External'
      dirs[0].value = 'external'
      dirs.slice(1, 3).forEach((dir, i) => {
        dir.name = `SD${i+1}`
        dir.value = `SD${i+1}`
      })
      return dirs
    } else {
      return []
    }
  }

  getInternalDir(path) {
    if (!this._internalDir) {
      this._internalDir = this._fs.supported ? this._fs.storageDir : 'idb'
    }
    return join(this._internalDir, path)
  }

  projectConfigPath(dir) {
    return join(dir, '.projects')
  }

  gitConfigPath() {
    return this.getInternalDir('.gitconfig')
  }

  preferencesPath() {
    return this.getInternalDir('.prefs')
  }

  settingsConfigPath() {
    return this.getInternalDir('.settings')
  }

  globalTasksConfigPath() {
    return this.getInternalDir('.metadata/.tasks/.global')
  }

  cachedUserDataPath() {
    return this.getInternalDir('.metadata/.user')
  }

  fontsDir() {
    return this.getInternalDir('.metadata/.fonts')
  }

  signatureDir() {
    return this.getInternalDir('.metadata/.sig')
  }

  projectTasksConfigPath(dir) {
    return join(`${dirname(dir)}/.metadata/.tasks`, basename(dir))
  }

  projectInfoPath(dir) {
    return join(`${dirname(dir)}/.metadata/.info`, basename(dir))
  }

  tmpDir(dir) {
    return join(`${dirname(dir)}/.tmp`, basename(dir))
  }

  metadataPath(dir) {
    return join(`${dirname(dir)}/.metadata`, basename(dir))
  }

  trashDir(dir) {
    return join(`${dirname(dir)}/.trash`, basename(dir))
  }
}

var ENV = new Environ(DFS)
