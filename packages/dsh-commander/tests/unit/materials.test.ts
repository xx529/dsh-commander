// 方案 A：报告材料构建（显式链接/文档/图片 + present 自动归并）与签名资产读取。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildReportMaterials } from '../../src/host/report-materials.ts'
import { createMaterialAssets } from '../../src/host/api/material-assets.ts'
import { createStores } from '../../src/host/store/index.ts'
import { commanderDomainSpec } from '../../src/host/domain.ts'
import { createFakeStorageDomain } from '../fakes/fakes.ts'
import type { AcceptanceItem, TaskRecord } from '../../src/host/schema.ts'

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=', 'base64')
const PDF = Buffer.from('%PDF-1.4\n% test\n1 0 obj\n<<>>\nendobj\n', 'utf8')

function acceptance(): AcceptanceItem[] {
  return [{ id: 'acc_1', text: 'A', source: 'commander', state: 'evidence_present' }]
}

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'dsh-commander-materials-'))
}

test('buildReportMaterials accepts links/files/local images, maps acceptanceIndex and dedupes present', async () => {
  const dir = await tempDir()
  try {
    const png = join(dir, 'shot.png')
    const pdf = join(dir, 'report.pdf')
    await writeFile(png, PNG)
    await writeFile(pdf, PDF)
    const realPng = await realpath(png)
    const realPdf = await realpath(pdf)
    const result = await buildReportMaterials({
      events: [{ seq: 7, type: 'deliverables/presented', data: { files: [{ path: png, description: 'present 的截图' }] } }],
      seqFrom: 1,
      seqTo: 10,
      sessionId: 'session-work-1',
      workspaceRoot: dir,
      rawMaterials: [
        { kind: 'link', title: '官方发布记录', url: 'https://docs.z.ai/release-notes', acceptanceIndex: 0 },
        { kind: 'file', title: '兼容性评估', path: 'report.pdf', description: '本地 PDF' },
        { kind: 'image', title: '配置截图', path: png, acceptanceIndex: 0 },
        { kind: 'link', title: 'bad', url: 'javascript:alert(1)' },
      ],
      acceptance: acceptance(),
    })
    assert.equal(result.materials.length, 3)
    const link = result.materials.find((material) => material.kind === 'link')
    assert.equal(link?.state, 'unverified')
    assert.deepEqual(link?.acceptanceIds, ['acc_1'])
    assert.equal(link?.source, 'commander')
    const file = result.materials.find((material) => material.kind === 'file')
    assert.equal(file?.path, realPdf)
    assert.equal(file?.state, 'ok')
    assert.equal(file?.meta?.bytes, PDF.byteLength)
    const image = result.materials.find((material) => material.kind === 'image')
    assert.equal(image?.path, realPng)
    assert.equal(image?.state, 'ok')
    assert.equal(image?.meta?.mime, 'image/png')
    // present 与显式图片同 realpath：不重复，保留显式标题与 acceptanceIds。
    assert.equal(result.materials.filter((material) => material.kind === 'image').length, 1)
    assert.deepEqual(image?.acceptanceIds, ['acc_1'])
    assert.ok(result.warnings.some((warning) => warning.includes('http(s)')))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('buildReportMaterials merges present files outside the workspace and rejects fake images', async () => {
  const workspace = await tempDir()
  const outside = await tempDir()
  try {
    const png = join(outside, 'present.png')
    const fake = join(workspace, 'fake.png')
    await writeFile(png, PNG)
    await writeFile(fake, 'not an image')
    const realPng = await realpath(png)
    const result = await buildReportMaterials({
      events: [{ seq: 5, type: 'deliverables/presented', data: { files: [{ path: png }] } }],
      seqFrom: 1,
      seqTo: 10,
      sessionId: 'session-work-1',
      workspaceRoot: workspace,
      rawMaterials: [{ kind: 'image', title: '假图片', path: fake }],
      acceptance: acceptance(),
    })
    assert.equal(result.materials.length, 1)
    assert.equal(result.materials[0]?.source, 'presented')
    assert.equal(result.materials[0]?.path, realPng)
    assert.equal(result.materials[0]?.state, 'ok')
    assert.ok(result.warnings.some((warning) => warning.includes('PNG/JPEG/WebP/GIF')))
  } finally {
    await rm(workspace, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
})

test('createMaterialAssets signs local image URLs, serves bytes and rejects bad signatures', async () => {
  const dir = await tempDir()
  try {
    const png = join(dir, 'shot.png')
    await writeFile(png, PNG)
    const domain = await createFakeStorageDomain().open(commanderDomainSpec)
    const stores = createStores(domain)
    const task: TaskRecord = {
      v: 1, id: 'task_mat_1', title: '材料', goal: 'g', status: 'review', workspaceId: 'ws-a', priority: 'normal',
      commandId: '', assignments: [], acceptance: [], timeline: [], version: 1, createdAt: 1, updatedAt: 1, lastActivityAt: 1,
      reportMaterials: [{
        id: 'mat_1', kind: 'image', title: '截图', path: png, source: 'commander', state: 'ok', meta: { mime: 'image/png', bytes: PNG.byteLength },
      }],
    }
    await stores.tasks.put(task)
    const assets = createMaterialAssets({ stores, origin: () => 'http://127.0.0.1:1234' })
    const url = assets.url('task_mat_1', task.reportMaterials![0]!)
    assert.match(url ?? '', /^http:\/\/127\.0\.0\.1:1234\/commander\/tasks\/task_mat_1\/materials\/mat_1\?sig=/)
    const sig = new URL(url as string).searchParams.get('sig') ?? ''
    const bytes = await assets.read('task_mat_1', 'mat_1', sig)
    assert.equal(bytes?.mime, 'image/png')
    assert.deepEqual(bytes?.bytes, PNG)
    assert.equal(await assets.read('task_mat_1', 'mat_1', 'bad'), undefined)
    assert.equal(await assets.read('task_other', 'mat_1', sig), undefined)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})


test('buildReportMaterials extracts links and images from the last assistant reply', async () => {
  const dir = await tempDir()
  try {
    const local = join(dir, 'diagram.png')
    await writeFile(local, PNG)
    const realLocal = await realpath(local)
    const events = [{
      seq: 9,
      type: 'assistant/message',
      data: {
        message: {
          content: [{
            type: 'text',
            text: [
              '关键链接：[官方规范](https://example.com/spec) 与 <https://example.com/bare>。',
              '![架构图](https://example.com/arch.png)',
              `![本地图](${local})`,
              '```',
              'https://example.com/in-code-fence',
              '```',
              '`https://example.com/inline-code`',
            ].join('\n'),
          }],
        },
      },
    }]
    const result = await buildReportMaterials({
      events,
      seqFrom: 1,
      seqTo: 10,
      sessionId: 'session-work-1',
      workspaceRoot: dir,
      rawMaterials: [],
      acceptance: acceptance(),
    })
    assert.equal(result.materials.filter((material) => material.kind === 'image').length, 2)
    assert.equal(result.materials.filter((material) => material.kind === 'link').length, 2)
    assert.ok(result.materials.every((material) => material.source === 'session'))
    assert.ok(result.materials.some((material) => material.title === '官方规范'))
    assert.ok(result.materials.some((material) => material.title === '架构图'))
    assert.ok(result.materials.some((material) => material.url === 'https://example.com/bare'))
    assert.ok(result.materials.some((material) => material.path === realLocal))
    assert.equal(result.materials.some((material) => material.url?.includes('in-code-fence') === true), false)
    assert.equal(result.materials.some((material) => material.url?.includes('inline-code') === true), false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})


test('extracted bare URLs trim trailing Chinese/ASCII punctuation before normalization', async () => {
  const events = [{
    seq: 3,
    type: 'assistant/message',
    data: { message: { content: [{ type: 'text', text: '参考 https://flutter.dev/blog/a2ui-launch)。 以及 https://example.com/doc，' }] } },
  }]
  const result = await buildReportMaterials({
    events,
    seqFrom: 1,
    seqTo: 10,
    sessionId: 'session-work-1',
    rawMaterials: [],
    acceptance: acceptance(),
  })
  const urls = result.materials.map((material) => material.url).sort()
  assert.deepEqual(urls, ['https://example.com/doc', 'https://flutter.dev/blog/a2ui-launch'])
})


test('extracted Markdown link lists separated by Chinese punctuation do not leak into bare URLs', async () => {
  const text = [
    '[演进指南 2.9 节](https://a2ui.org/specification/v1.0-evolution-guide/)、',
    '[10-27 Express 推理格式](https://developers.googleblog.com/fast-reliable-a2ui)、',
    '[10-29 CopilotKit 教程](https://developers.googleblog.com/build-generative-ui-apps-with-a2ui-copilotkit-agents)、',
    '[11-11 A2UI 1.0](https://developers.googleblog.com/a2ui-10-build-delightful-fast-reliable-agentic-experiences)、',
    '[11-17 Flutter 博客](https://flutter.dev/blog/a2ui-launch)。',
  ].join('')
  const result = await buildReportMaterials({
    events: [{ seq: 8, type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } } }],
    seqFrom: 1,
    seqTo: 10,
    sessionId: 'session-work-1',
    rawMaterials: [],
    acceptance: acceptance(),
  })
  const urls = result.materials.map((material) => material.url).filter((url): url is string => url !== undefined)
  assert.equal(urls.length, 5)
  assert.equal(urls.every((url) => !url.includes(')') && !url.includes('%E3%80%82') && !url.includes('%E3%80%81')), true)
  assert.deepEqual(new Set(urls).size, 5)
  assert.equal(result.materials.some((material) => material.title === '演进指南 2.9 节'), true)
  assert.equal(result.materials.some((material) => material.title === '11-17 Flutter 博客'), true)
})
