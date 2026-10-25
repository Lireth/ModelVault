import { dialog } from 'electron'
import fs from 'node:fs/promises'
import path from 'node:path'
import logger from '../logger'
import { runMaintenance } from './maintenance-lock'
import {
  COVERS_DIR,
  DATA_DIR,
  DATA_FILE,
  LIB_SETTINGS_FILE,
  flushSettingsSave,
  flushStoreSave,
  getCurrentRoot,
  getModelMeta,
  normalizeLibrarySettings,
  normalizeStoreData,
  saveLibrarySettings,
  setModelMeta,
} from './store'
import { LIB_PREFIX, parseBackupManifest } from './backup-format'
import {
  readBackupManifest,
  streamBackupZip,
  unzipBackupEntries,
} from './backup-zip'

/**
 * 备份恢复流程（O2 拆分）：
 * 全量恢复走「流式解出 → 校验规范化 → 目录交换」：既有数据留 .bak 可回滚，
 * 恢复中断/失败不在用户目录留半成品；选择性/元数据备份（FN-08 partial）
 * 走「合并恢复」：只把备份中的模型标注合并进当前库，保留现有封面与其他模型。
 * 全程与扫描/切库互斥（V-02 维护锁）。
 */

/** 备份文件大小上限（O5/B-04）：压缩包本身仍做上限校验，避免超大文件
 * 长时间占用磁盘/CPU；解压侧另有逐条与总量限制（backup-zip） */
const MAX_BACKUP_BYTES = 2 * 1024 * 1024 * 1024

/** 恢复临时目录前缀（解出校验用，成功即改名，残留即垃圾） */
const RESTORE_TMP_PREFIX = `${DATA_DIR}.restore-`
/** 覆盖恢复时旧数据的留存目录前缀 */
const BACKUP_DIR_PREFIX = `${DATA_DIR}.bak-`

/** 路径存在性判断（不区分文件/目录） */
async function pathExists(p) {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

/**
 * 清理恢复过程的残留目录（OPT-18）：
 * - `.modelvault.restore-*`：解出用临时目录，正常流程结束时应已改名，存在即残留；
 * - `.modelvault.bak-*`：覆盖恢复的旧数据留存，仅保留最新一份（keepBak），
 *   更早的属可重复生成的陈旧副本——不清除会在用户模型目录无限累积
 *   （每份含全部封面，可达数百 MB）。
 * 单项删除失败仅告警，不中断恢复主流程。
 * @param {string} root 目标模型根目录
 * @param {string} keepBakName 本次恢复生成的 .bak 目录名（basename；无既有数据时为空串）
 */
async function pruneRestoreArtifacts(root, keepBakName) {
  let entries
  try {
    entries = await fs.readdir(root)
  } catch {
    return
  }
  for (const name of entries) {
    const isStaleTmp = name.startsWith(RESTORE_TMP_PREFIX)
    const isOldBackup =
      name.startsWith(BACKUP_DIR_PREFIX) && name !== keepBakName
    if (!isStaleTmp && !isOldBackup) continue
    await fs
      .rm(path.join(root, name), { recursive: true, force: true })
      .catch((err) => {
        logger.warn(`清理恢复残留目录失败: ${err.message}`)
      })
  }
}

/**
 * 从备份恢复库数据到目标模型根目录（流式解出 → 校验 → 目录交换）：
 * 既有数据留 .bak 而非直接删除，恢复中断可回滚；失败即清理本次临时目录，
 * 成功后按「仅保留最新 .bak」治理残留（OPT-18）。
 * OPT-10：封面在解压完成时直接写入临时目录，不再先聚合到内存条目表；
 * store/settings 等小条目仍保留在内存中用于校验与规范化。
 * @param {string} root 目标模型根目录
 * @param {string} filePath 备份 zip 路径
 * @param {number} [skippedCovers] 解压阶段跳过的非法封面条目数（B-04）
 * @param {boolean} [restoreSettings] 是否恢复备份中的库设置（manifest.settings）
 * @returns {Promise<{root: string, models: number, covers: number, skipped: number,
 *   settingsRestored: boolean}>}
 */
async function restoreLibrary(
  root,
  filePath,
  skippedCovers = 0,
  restoreSettings = true,
) {
  // V-02：恢复会整体替换目标库的 .modelvault，必须与扫描/局部扫描/切库互斥。
  // 拿不到锁时抛出 EBUSY，由 importBackup 转换为「正在…，请稍候」
  return runMaintenance('restore', root, () =>
    restoreLibraryLocked(root, filePath, skippedCovers, restoreSettings),
  )
}

/**
 * 恢复库数据（调用方已持有全局维护锁）。
 * @param {string} root 目标模型根目录
 * @param {string} filePath 备份 zip 路径
 * @param {number} skippedCovers 解压阶段跳过的非法封面条目数
 */
async function restoreLibraryLocked(
  root,
  filePath,
  skippedCovers = 0,
  restoreSettings = true,
) {
  // 静止两路写盘链（B1/B-02 修复配套）：在途的防抖/原子写完成于目录交换之后时，
  // 其 rename 会把恢复前的旧数据覆盖到刚恢复的 store.json / settings.json 上。
  // 恢复目标为当前激活根时风险最大；对其他根 flush 只是把当前根待落盘数据
  // 写进其自身文件，无副作用
  await Promise.all([flushStoreSave(), flushSettingsSave()])

  const dataDir = path.join(root, DATA_DIR)
  const stamp = Date.now()
  const tmpDir = `${dataDir}.restore-${stamp}`
  const coversDir = path.join(tmpDir, COVERS_DIR)
  await fs.rm(tmpDir, { recursive: true, force: true })
  let covers = 0
  try {
    await fs.mkdir(coversDir, { recursive: true })
    const stats = { skippedCovers }
    const decoder = new TextDecoder()
    // 封面解压完成即落盘：临时目录仅承载文件，内存中只保留当前封面字节
    const unzipped = await streamBackupZip(filePath, {
      stats,
      // name 由 safeCoverName 校验过（不安全条目在解压阶段已跳过），此处可直接落盘
      coverWriter: async (name, data) => {
        await fs.writeFile(path.join(coversDir, name), data)
        covers += 1
      },
    })

    const storeBytes = unzipped[`${LIB_PREFIX}${DATA_FILE}`]
    if (!storeBytes) throw new Error('备份缺少库元数据')
    const storeText = decoder.decode(storeBytes)
    // 落盘前先校验 JSON 并规范化（B-04）：备份来自不可信来源，
    // store.json 的键与字段必须按与磁盘加载相同的规则清洗（原型污染/超大字段）
    const parsed = JSON.parse(storeText)
    const sanitized = normalizeStoreData(parsed)
    const sanitizedText = JSON.stringify(sanitized, null, 2)
    const sourceCount =
      parsed &&
      typeof parsed === 'object' &&
      parsed.models &&
      typeof parsed.models === 'object'
        ? Object.keys(parsed.models).length
        : 0
    if (Object.keys(sanitized.models).length !== sourceCount) {
      logger.warn(
        `备份元数据已清洗: ${sourceCount} → ${Object.keys(sanitized.models).length} 条（剔除非法键/字段）`,
      )
    }
    await fs.writeFile(path.join(tmpDir, DATA_FILE), sanitizedText)

    let settingsRestored = false
    if (restoreSettings && unzipped['settings.json']) {
      // 库设置随备份恢复（设置随模型库走）：写入临时目录，随目录交换原子生效
      const parsedSettings = JSON.parse(
        decoder.decode(unzipped['settings.json']),
      )
      const normalizedSettings = normalizeLibrarySettings(parsedSettings)
      await fs.writeFile(
        path.join(tmpDir, LIB_SETTINGS_FILE),
        JSON.stringify(normalizedSettings, null, 2),
      )
      settingsRestored = true
    }

    // 交换：既有目录让位到 .bak，临时目录上位；上位失败则回滚，目标目录不留半成品
    let bakDir = ''
    if (await pathExists(dataDir)) {
      bakDir = `${dataDir}.bak-${stamp}`
      await fs.rename(dataDir, bakDir)
      try {
        await fs.rename(tmpDir, dataDir)
      } catch (err) {
        await fs.rename(bakDir, dataDir)
        throw err
      }
    } else {
      await fs.rename(tmpDir, dataDir)
    }

    // 残留治理（OPT-18）：更早的 .bak 仅保留本次一份；历史 .restore 临时目录清除
    await pruneRestoreArtifacts(root, bakDir ? path.basename(bakDir) : '')
    return {
      root,
      models: Object.keys(sanitized.models).length,
      covers,
      skipped: stats.skippedCovers,
      settingsRestored,
    }
  } catch (err) {
    // 失败兜底：清理本次解出的临时目录，不在用户模型目录留垃圾
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
    throw err
  }
}

/** 选择性恢复前的 store.json 快照（最多保留 10 份，失败不阻断恢复） */
async function snapshotSelectiveStore(root, stamp) {
  const source = path.join(root, DATA_DIR, DATA_FILE)
  if (!(await pathExists(source))) return ''
  const dir = path.join(root, DATA_DIR, 'backups')
  try {
    await fs.mkdir(dir, { recursive: true })
    const dest = path.join(dir, `store-selective-${stamp}.json`)
    await fs.copyFile(source, dest)
    const names = (await fs.readdir(dir))
      .filter((name) => name.startsWith('store-selective-'))
      .sort()
    for (const old of names.slice(0, Math.max(0, names.length - 10))) {
      await fs.rm(path.join(dir, old), { force: true }).catch(() => {})
    }
    return dest
  } catch (err) {
    logger.warn(`选择性恢复前快照失败（继续合并）: ${err.message}`)
    return ''
  }
}

/**
 * 选择性/元数据备份的合并恢复（FN-08）：
 * 与全量恢复的目录交换不同，这里只把备份中的模型标注合并进当前库，
 * 保留现有封面与其他模型；同名相对路径以备份内容覆盖。
 * 仅支持当前激活库（setModelMeta 以当前根目录为基准）。
 * @param {string} root 当前激活模型根目录
 * @param {string} filePath 备份 zip
 * @param {import('./backup-format').BackupManifest} manifest 已校验的清单
 * @returns {Promise<{root: string, models: number, covers: number, skipped: number,
 *   settingsRestored: boolean, partial: boolean, mode: string, backupPath: string}>}
 */
async function restorePartialLibrary(root, filePath, manifest) {
  return runMaintenance('restore', root, async () => {
    await Promise.all([flushStoreSave(), flushSettingsSave()])
    const dataDir = path.join(root, DATA_DIR)
    const coversDir = path.join(dataDir, COVERS_DIR)
    await fs.mkdir(coversDir, { recursive: true })

    // 封面同名不覆盖（既有文件优先）；新文件直接写入当前库封面目录。
    // 若后续校验/合并失败，删除本次新写入的封面，避免在库内留下半成品。
    let covers = 0
    const writtenCovers = []
    try {
      const unzipped = await streamBackupZip(filePath, {
        coverWriter: async (name, data) => {
          const dest = path.join(coversDir, name)
          const exists = await fs.access(dest).then(
            () => true,
            () => false,
          )
          if (exists) return
          await fs.writeFile(dest, data)
          writtenCovers.push(dest)
          covers += 1
        },
      })
      const storeBytes = unzipped[`${LIB_PREFIX}${DATA_FILE}`]
      if (!storeBytes) throw new Error('备份缺少库元数据')
      const parsed = JSON.parse(new TextDecoder().decode(storeBytes))
      const sanitized = normalizeStoreData(parsed)
      const stamp = Date.now()
      const backupPath = await snapshotSelectiveStore(root, stamp)

      let added = 0
      let updated = 0
      let skipped = 0
      const metadataOnly = manifest.mode === 'metadata'
      for (const [relKey, meta] of Object.entries(sanitized.models)) {
        const abs = path.join(root, relKey)
        const existed = Boolean(getModelMeta(abs))
        // metadata-only 备份不含封面：清空封面引用，避免恢复后指向不存在的文件
        const incoming = metadataOnly
          ? { ...meta, covers: [], cover: '' }
          : meta
        const saved = setModelMeta(abs, incoming)
        if (!saved) {
          skipped += 1
          continue
        }
        if (existed) updated += 1
        else added += 1
      }
      await flushStoreSave()
      logger.info(
        `选择性备份已合并: ${filePath} → ${root}（新增 ${added} / 更新 ${updated} / 跳过 ${skipped}）`,
      )
      return {
        root,
        models: added + updated,
        covers,
        skipped,
        settingsRestored: false,
        partial: true,
        mode: manifest.mode || 'selected',
        added,
        updated,
        backupPath,
      }
    } catch (err) {
      for (const file of writtenCovers) {
        await fs.rm(file, { force: true }).catch(() => {})
      }
      throw err
    }
  })
}

/**
 * 从备份恢复：依次经原生对话框完成「选备份文件 →（含库数据时）选目标文件夹
 * → 覆盖确认」，全流程在主进程完成，渲染进程一次调用即可。
 * @param {import('electron').BrowserWindow} win 父窗口
 * @returns {Promise<import('./backup-format').BackupRestoreResult>}
 */
export async function importBackup(win) {
  const pick = await dialog.showOpenDialog(win, {
    title: '选择备份文件',
    properties: ['openFile'],
    filters: [{ name: 'ModelVault 备份', extensions: ['zip'] }],
  })
  if (pick.canceled || !pick.filePaths[0]) return { canceled: true }
  const filePath = pick.filePaths[0]

  let manifestBytes
  try {
    // 大小预检（O5）：先于读取——超大压缩包长时间占用磁盘/CPU；
    // 解压侧另有逐条与总量上限（B-04）
    const fileStat = await fs.stat(filePath)
    if (fileStat.size > MAX_BACKUP_BYTES) {
      return {
        error: `备份文件超过 ${Math.floor(MAX_BACKUP_BYTES / 1024 / 1024 / 1024)}GB，为避免内存占用过高已停止恢复；请手动复制 .modelvault 文件夹`,
      }
    }
    // 第一遍：流式只读 manifest（B-04）。无效备份不进入完整解压。
    manifestBytes = await readBackupManifest(filePath)
  } catch (err) {
    return { error: `备份文件读取失败: ${err.message}` }
  }
  const parsedManifest = parseBackupManifest(manifestBytes)
  if (!parsedManifest.ok) return { error: parsedManifest.error }
  const manifest = parsedManifest.manifest

  // FN-08：选择性/元数据备份走合并恢复（不替换目录、不恢复设置）。
  // 仅支持当前激活库——合并基于当前根的相对路径关联。
  if (manifest.partial === true) {
    const root = getCurrentRoot()
    if (!root) {
      return {
        error: '选择性备份只能合并到当前激活的模型库，请先打开目标模型库',
        settingsRestored: false,
        partial: true,
      }
    }
    const count =
      manifest.library && Number.isFinite(manifest.library.models)
        ? manifest.library.models
        : 0
    const choice = await dialog.showMessageBox(win, {
      type: 'warning',
      title: '合并恢复确认',
      message: `将把备份中的 ${count} 个模型标注合并到当前模型库`,
      detail:
        `目标：${root}\n` +
        '同名模型的标注会被备份内容覆盖；现有封面与其他模型保持不变。' +
        '恢复前会自动快照 store.json（.modelvault/backups/）。',
      buttons: ['取消', '合并恢复'],
      defaultId: 0,
      cancelId: 0,
    })
    if (choice.response !== 1) {
      return { error: '已取消合并恢复', settingsRestored: false, partial: true }
    }
    try {
      const libraryRestored = await restorePartialLibrary(
        root,
        filePath,
        manifest,
      )
      return {
        settingsRestored: false,
        libraryRestored,
        skipped: libraryRestored.skipped,
      }
    } catch (err) {
      if (err?.code === 'EBUSY') {
        return { error: err.message, settingsRestored: false, partial: true }
      }
      logger.warn(`选择性备份合并失败: ${err.message}`)
      return {
        error: `选择性备份合并失败: ${err.message}`,
        settingsRestored: false,
        partial: true,
      }
    }
  }

  // 第二遍在确定恢复路径后再执行：
  // - 含库数据：先选目标目录，再在维护锁内流式解压，封面逐张落盘；
  // - 仅设置：跳过封面解压，只读取设置/元数据。
  // 库设置随模型库走：含库数据时写入目标库的 .modelvault/settings.json；
  // 引导字段（激活库/库列表）一律剥离，避免恢复到任意文件夹时劫持本机库列表。
  if (manifest.library) {
    const target = await dialog.showOpenDialog(win, {
      title: '选择要恢复到的模型文件夹',
      properties: ['openDirectory'],
    })
    if (target.canceled || !target.filePaths[0]) {
      return {
        error: '已取消选择目标文件夹（设置与库数据均未恢复）',
        settingsRestored: false,
        partial: true,
      }
    }
    const root = target.filePaths[0]
    if (await pathExists(path.join(root, DATA_DIR))) {
      const choice = await dialog.showMessageBox(win, {
        type: 'warning',
        title: '覆盖确认',
        message: '目标文件夹已存在关联数据（.modelvault）',
        detail:
          '恢复将覆盖其中的标注与封面。现有数据会先备份为 .modelvault.bak-<时间戳>（仅保留最新一份，更早的自动清理），确认无误后可手动删除。',
        buttons: ['取消', '覆盖恢复'],
        defaultId: 0,
        cancelId: 0,
      })
      if (choice.response !== 1) {
        return {
          error: '已取消覆盖恢复（设置与库数据均未恢复）',
          settingsRestored: false,
          partial: true,
        }
      }
    }
    try {
      const libraryRestored = await restoreLibrary(
        root,
        filePath,
        0,
        manifest.settings === true,
      )
      logger.info(
        `备份已恢复: ${filePath} → ${root}（${libraryRestored.models} 模型 / ${libraryRestored.covers} 封面）`,
      )
      return {
        settingsRestored: libraryRestored.settingsRestored,
        libraryRestored,
        skipped: libraryRestored.skipped,
      }
    } catch (err) {
      logger.warn(`备份恢复失败: ${err.message}`)
      return {
        error: `库数据恢复失败: ${err.message}`,
        settingsRestored: false,
        partial: true,
      }
    }
  }

  // 仅设置的备份（无库数据，含旧格式 settings-only）：写入当前激活库随库生效；
  // 尚无激活库时无处落盘，保持未恢复状态。
  // skipCovers：此路径不恢复库数据，封面条目连解压都不做，避免无效内存/CPU。
  let unpacked
  try {
    unpacked = await unzipBackupEntries(filePath, { skipCovers: true })
  } catch (err) {
    return { error: `备份文件解压失败: ${err.message}` }
  }
  let settingsPayload = null
  if (manifest.settings && unpacked.files['settings.json']) {
    try {
      const parsed = JSON.parse(
        new TextDecoder().decode(unpacked.files['settings.json']),
      )
      settingsPayload = normalizeLibrarySettings(parsed)
    } catch (err) {
      return { error: `备份中的设置数据损坏: ${err.message}` }
    }
  }
  if (settingsPayload) {
    const root = getCurrentRoot()
    if (root) {
      // 与库恢复一致：设置写入也需与扫描/切库互斥（V-02）
      await runMaintenance('restore', root, () =>
        saveLibrarySettings(root, settingsPayload),
      )
      logger.info(`备份中的库设置已写入当前模型库: ${root}`)
      return { settingsRestored: true }
    }
    logger.warn('备份含库设置但当前无激活模型库，设置未恢复')
  }
  return { settingsRestored: false }
}
