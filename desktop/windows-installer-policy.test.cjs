const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const projectRoot = path.resolve(__dirname, '..')
const builderConfiguration = fs.readFileSync(
  path.join(projectRoot, 'electron-builder.yml'),
  'utf8',
)
const installerInclude = fs.readFileSync(
  path.join(projectRoot, 'build', 'installer.nsh'),
  'utf8',
)

test('Windows installer explicitly enables the data-preserving NSIS policy', () => {
  assert.match(builderConfiguration, /^\s+include: build\/installer\.nsh$/m)
  assert.match(installerInclude, /!macro customInit/)
  assert.match(installerInclude, /!macro customInstall/)
  assert.match(installerInclude, /!macro customRemoveFiles/)
})

test('legacy upgrades bypass the cross-volume uninstaller only until the safe marker is written', () => {
  assert.match(installerInclude, /DataPreservingUninstaller/)
  assert.match(installerInclude, /DeleteRegKey HKCU "\$\{UNINSTALL_REGISTRY_KEY\}"/)
  assert.match(installerInclude, /WriteRegDWORD HKCU "\$\{INSTALL_REGISTRY_KEY\}"/)
})

test('uninstall and update preserve VibeSeq Data outside INSTDIR before recursive removal', () => {
  const preserve = installerInclude.indexOf(
    'Rename "$INSTDIR\\${VIBESEQ_DATA_DIRECTORY}" "$R7"',
  )
  const remove = installerInclude.indexOf('RMDir /r "$INSTDIR"')
  const restore = installerInclude.lastIndexOf(
    '!insertmacro VibeSeqRestorePreservedData',
  )

  assert.ok(preserve >= 0, 'policy must preserve VibeSeq Data')
  assert.ok(remove > preserve, 'app removal must happen after data preservation')
  assert.ok(restore > remove, 'data restoration must happen after app removal')
  assert.doesNotMatch(installerInclude, /RMDir \/r "\$INSTDIR\\\$\{VIBESEQ_DATA_DIRECTORY\}"/)
})
