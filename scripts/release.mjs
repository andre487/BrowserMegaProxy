import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export function validateVersion(version, current) {
  assert.match(
    version,
    /^(0|[1-9]\d{0,4})\.(0|[1-9]\d{0,4})\.(0|[1-9]\d{0,4})$/,
    'Use X.Y.Z without a v prefix or prerelease suffix'
  )
  const parts = version.split('.').map(Number)
  assert.ok(
    parts.every(part => part <= 65535) && parts.some(Boolean),
    'Browser version components must be 0–65535 and the version must not be 0.0.0'
  )
  if (current !== undefined) {
    const old = current.split('.').map(Number)
    const index = parts.findIndex((part, i) => part !== old[i])
    assert.ok(index >= 0 && parts[index] > old[index], `Version must be newer than ${current}`)
  }
  return version
}

export async function packageRelease() {
  const pkg = JSON.parse(await readFile('package.json', 'utf8'))
  const version = validateVersion(pkg.version)
  const tag = `v${version}`
  if (process.env.GITHUB_REF_TYPE === 'tag') {
    assert.equal(process.env.GITHUB_REF_NAME, tag, 'Release tag must match package.json')
  }
  const lock = JSON.parse(await readFile('package-lock.json', 'utf8'))
  assert.equal(lock.version, version)
  assert.equal(lock.packages[''].version, version)
  const dir = path.resolve('dist/release')
  await rm(dir, { recursive: true, force: true })
  await mkdir(dir, { recursive: true })
  const files = []
  for (const target of ['chromium', 'firefox']) {
    const manifest = JSON.parse(await readFile(`dist/${target}/manifest.json`, 'utf8'))
    assert.equal(manifest.version, version)
    const name = `MegaProxy-${target}-${tag}.zip`
    execFileSync('zip', ['-q', '-r', `${dir}/${name}`, '.'], { cwd: `dist/${target}` })
    assert.ok(
      execFileSync('unzip', ['-Z1', `${dir}/${name}`], { encoding: 'utf8' })
        .split('\n')
        .includes('manifest.json'),
      'manifest.json must be at the archive root'
    )
    files.push(name)
  }
  const source = `MegaProxy-source-${tag}.zip`
  execFileSync('git', ['archive', '--format=zip', `--output=${dir}/${source}`, 'HEAD'])
  files.push(source)
  const materials = `MegaProxy-store-materials-${tag}.zip`
  execFileSync('zip', ['-q', '-r', `${dir}/${materials}`, 'store'])
  files.push(materials)
  const sums = await Promise.all(
    files.map(
      async name =>
        `${createHash('sha256')
          .update(await readFile(`${dir}/${name}`))
          .digest('hex')}  ${name}`
    )
  )
  await writeFile(`${dir}/SHA256SUMS`, `${sums.join('\n')}\n`)
  console.log(`Release archives ready in ${dir}`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === 'validate') {
    const pkg = JSON.parse(await readFile('package.json', 'utf8'))
    validateVersion(process.argv[3], pkg.version)
  } else if (process.argv[2] === 'package') {
    await packageRelease()
  } else {
    throw new Error('Use release.mjs validate X.Y.Z or release.mjs package')
  }
}
