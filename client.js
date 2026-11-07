/**
 * rp-card-plugin — 客户端半边。
 *
 * 两处 UI，共用同一套密钥读写（remote.credentials）：
 * 1) image_asset setup 动作 → 真正的弹窗（遮罩 + 居中卡片）
 * 2) 设置 → 插件 → 图像能力 → 常驻配置页，不经过对话也能改
 */

window.__ModuleLoader__.load({
  id: 'dsh-rp-card',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')

    const ENV = {
      seedream: 'IMAGE_GEN_PROVIDER_API_KEY',
      recraft: 'RECRAFT_API_KEY',
      mode: 'RP_CARD_IMAGE_MODE',
    }

    const LINKS = {
      seedream: 'https://console.volcengine.com/ark/region:cn-beijing/overview',
      recraft: 'https://www.recraft.ai/docs/api-reference/getting-started',
    }

    const INTRO = '当前已进入前端设计，由于deepseek模型无图像生成能力，推荐接入图像生成模型。图像模型预留默认Seedream5.0flash（豆包生图同源）与recraftV4.1接口。如选择默认接口，只需填写 API Key。供应商地址、模型与参数都已内置，不需要填写。调用图像模型需要在模型提供商充值余额。如不希望额外花费，可选择纯代码实现。'

    const css = {
      backdrop: {
        position: 'fixed', inset: 0, zIndex: 2147483000,
        background: 'rgba(0, 0, 0, 0.45)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 16, backdropFilter: 'blur(2px)',
      },
      card: {
        width: 'min(560px, 100%)', maxHeight: 'calc(100vh - 64px)', overflow: 'auto',
        borderRadius: 14, padding: '18px 20px',
        background: 'var(--dsw-alias-bg-modal, var(--dsw-alias-bg-module-platform, #fff))',
        color: 'var(--dsw-alias-label-primary, #1a1a1a)',
        boxShadow: '0 18px 48px rgba(0,0,0,.28)',
        display: 'flex', flexDirection: 'column', gap: 12,
      },
      page: { display: 'flex', flexDirection: 'column', gap: 12, padding: '4px 2px 8px' },
      head: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
      title: { fontSize: 16, fontWeight: 650 },
      close: {
        width: 28, height: 28, borderRadius: 8, border: 'none', cursor: 'pointer',
        background: 'transparent', color: 'var(--dsw-alias-label-secondary, #666)', fontSize: 18, lineHeight: '24px',
      },
      desc: { fontSize: 13, lineHeight: '21px', color: 'var(--dsw-alias-label-secondary, #6b6b6b)', margin: 0 },
      row: { display: 'flex', flexDirection: 'column', gap: 6, paddingTop: 12, borderTop: '1px dashed var(--dsw-alias-border-secondary, #e3e3e3)' },
      rowHead: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' },
      label: { fontSize: 13.5, fontWeight: 600 },
      state: { fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 4 },
      hint: { fontSize: 12, color: 'var(--dsw-alias-label-secondary, #7a7a7a)' },
      link: { fontSize: 12, color: 'var(--dsw-alias-label-link, #2563eb)', textDecoration: 'underline' },
      input: {
        boxSizing: 'border-box', width: '100%', height: 36, borderRadius: 9,
        border: '1px solid var(--dsw-alias-border-secondary, #d0d0d0)',
        background: 'var(--dsw-alias-bg-input, #fff)',
        color: 'var(--dsw-alias-label-primary, #1a1a1a)',
        padding: '0 11px', font: 'inherit', fontSize: 13,
      },
      actions: { display: 'flex', gap: 8, flexWrap: 'wrap', paddingTop: 6 },
      // 主按钮：固定白底黑字，不受主题变量影响
      primary: {
        height: 34, padding: '0 16px', borderRadius: 9, cursor: 'pointer', fontSize: 13, fontWeight: 600,
        border: '1px solid #cfcfcf',
        background: '#ffffff',
        color: '#111111',
      },
      ghost: {
        height: 34, padding: '0 12px', borderRadius: 9, cursor: 'pointer', fontSize: 13,
        border: '1px solid var(--dsw-alias-border-secondary, #d0d0d0)',
        background: 'transparent', color: 'var(--dsw-alias-label-primary, #1a1a1a)',
      },
      note: { fontSize: 12, lineHeight: '18px', margin: 0, color: 'var(--dsw-alias-label-secondary, #666)' },
      error: { fontSize: 12.5, margin: 0, color: 'var(--dsw-alias-label-error, #d92d20)' },
      ok: { fontSize: 12.5, margin: 0, color: 'var(--dsw-alias-label-success, #079455)' },
      inline: { fontSize: 12.5, lineHeight: '20px', color: 'var(--dsw-alias-label-secondary, #666)', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' },
    }

    function parseArgs(raw) {
      if (typeof raw !== 'string' || !raw.trim()) return {}
      try { return JSON.parse(raw) } catch { return {} }
    }

    function Row(props) {
      const { name, hint, link, configured, value, onChange } = props
      return React.createElement('div', { style: css.row },
        React.createElement('div', { style: css.rowHead },
          React.createElement('span', { style: css.label }, name),
          React.createElement('span', {
            style: { ...css.state, color: configured ? 'var(--dsw-alias-label-success, #079455)' : 'var(--dsw-alias-label-secondary, #7a7a7a)' },
          }, configured ? '● 已配置' : '○ 未配置'),
        ),
        React.createElement('span', { style: css.hint }, hint),
        React.createElement('a', { style: css.link, href: link, target: '_blank', rel: 'noreferrer' }, '获取 API Key →'),
        React.createElement('input', {
          style: css.input, type: 'password', autoComplete: 'off', spellCheck: false, value,
          placeholder: configured ? '已保存；留空表示不修改' : '粘贴 API Key',
          onChange: (e) => onChange(e.target.value),
        }),
      )
    }

    /** 弹窗与设置页共用的主体 */
    function SetupBody(props) {
      const { credentials, onDone } = props
      const [state, setState] = React.useState({ seedream: false, recraft: false, pureCode: false })
      const [seedream, setSeedream] = React.useState('')
      const [recraft, setRecraft] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState('')
      const [done, setDone] = React.useState('')

      const refresh = React.useCallback(async () => {
        if (!credentials) return
        try {
          const res = await credentials.describe([ENV.seedream, ENV.recraft, ENV.mode])
          const value = (res && res.ok && res.value) || {}
          setState({
            seedream: Boolean(value[ENV.seedream] && value[ENV.seedream].configured === true),
            recraft: Boolean(value[ENV.recraft] && value[ENV.recraft].configured === true),
            pureCode: Boolean(value[ENV.mode] && value[ENV.mode].configured === true),
          })
        } catch (e) {
          setError(e && e.message ? e.message : '读取密钥状态失败')
        }
      }, [credentials])

      React.useEffect(() => { void refresh() }, [refresh])

      const run = async (fn, okText, closeAfter) => {
        setBusy(true); setError(''); setDone('')
        try {
          await fn()
          await refresh()
          setDone(okText)
          if (closeAfter) window.setTimeout(() => { if (onDone) onDone() }, 700)
        } catch (e) {
          setError(e && e.message ? e.message : '操作失败')
        } finally { setBusy(false) }
      }

      const save = () => run(async () => {
        const hasInput = Boolean(seedream.trim() || recraft.trim())
        const hasExisting = state.seedream || state.recraft
        if (!hasInput && !hasExisting) throw new Error('至少填写一个密钥')
        if (seedream.trim()) await credentials.set(ENV.seedream, seedream.trim())
        if (recraft.trim()) await credentials.set(ENV.recraft, recraft.trim())
        await credentials.set(ENV.mode, 'keys')
        setSeedream(''); setRecraft('')
      }, '密钥已保存。', true)

      const skip = () => run(async () => {
        await credentials.set(ENV.mode, 'none')
      }, '已记录：不接入图像模型，后续按纯代码前端执行。', false)

      const resume = () => run(async () => {
        await credentials.set(ENV.mode, 'keys')
      }, '已重新启用图像能力。', false)

      return React.createElement('div', { style: css.page },
        React.createElement('p', { style: css.desc }, INTRO),
        React.createElement(Row, {
          name: 'Seedream5.0flash（火山方舟 · 豆包同源）', hint: '位图：背景图 / 地图 / 场景插画 / 带环境的人物图',
          link: LINKS.seedream, configured: state.seedream, value: seedream, onChange: setSeedream,
        }),
        React.createElement(Row, {
          name: 'recraftV4.1（Recraft）', hint: '矢量：图标 / 装饰 / 需要透明背景的人物立绘',
          link: LINKS.recraft, configured: state.recraft, value: recraft, onChange: setRecraft,
        }),
        error ? React.createElement('p', { style: css.error }, error) : null,
        done ? React.createElement('p', { style: css.ok }, done) : null,
        state.pureCode ? React.createElement('p', { style: css.note }, '当前为「不接入图像模型」：前端按纯代码实现，不再调用图像接口。') : null,
        React.createElement('div', { style: css.actions },
          React.createElement('button', {
            type: 'button', style: { ...css.primary, opacity: busy ? 0.6 : 1 }, disabled: busy, onClick: save,
          }, busy ? '保存中…' : '保存并继续'),
          React.createElement('button', { type: 'button', style: css.ghost, disabled: busy, onClick: skip }, '不接入图像模型（纯代码实现）'),
          state.pureCode
            ? React.createElement('button', { type: 'button', style: css.ghost, disabled: busy, onClick: resume }, '重新启用图像能力')
            : null,
        ),
      )
    }

    function SetupModal(props) {
      const { credentials, onClose } = props
      React.useEffect(() => {
        const onKey = (e) => { if (e.key === 'Escape') onClose() }
        window.addEventListener('keydown', onKey)
        const prev = document.body.style.overflow
        document.body.style.overflow = 'hidden'
        return () => { window.removeEventListener('keydown', onKey); document.body.style.overflow = prev }
      }, [onClose])
      return React.createElement('div', {
        style: css.backdrop,
        onMouseDown: (e) => { if (e.target === e.currentTarget) onClose() },
      },
        React.createElement('div', { style: css.card, role: 'dialog', 'aria-modal': 'true', 'aria-label': '配置图像能力' },
          React.createElement('div', { style: css.head },
            React.createElement('div', { style: css.title }, '配置图像能力'),
            React.createElement('button', { type: 'button', style: css.close, onClick: onClose, 'aria-label': '关闭' }, '×'),
          ),
          React.createElement(SetupBody, { credentials, onDone: onClose }),
        ),
      )
    }

    /** 设置 → 插件 → 图像能力：常驻页，不依赖对话 */
    function SettingsPanel(props) {
      return React.createElement('div', { style: { padding: '2px 0' } },
        React.createElement(SetupBody, { credentials: props.credentials }),
      )
    }

    function resultText(block) {
      const parts = []
      const push = (list) => {
        for (const item of Array.isArray(list) ? list : []) {
          if (item && typeof item.text === 'string') parts.push(item.text)
        }
      }
      if (typeof block.error === 'string') parts.push(block.error)
      push(block.content)
      if (block.result) push(block.result.content)
      return parts.join('\n')
    }

    function ImageAssetToolview(props) {
      const { block } = props
      const [closed, setClosed] = React.useState(false)
      if (block === undefined || block === null) return null
      const phase = typeof props.phase === 'string' ? props.phase : ('kind' in block ? 'result' : 'start')
      const settled = phase === 'result'
      const args = parseArgs((settled ? block.call && block.call.argsRaw : block.argsRaw) || '')
      const text = resultText(block)
      const isSetup = args.action === 'setup' || /"kind"\s*:\s*"image-setup"/.test(text)
      if (isSetup && settled && block.isError !== true) {
        if (closed) {
          return React.createElement('div', { style: { ...css.inline, display: 'flex', gap: 8, alignItems: 'center' } },
            React.createElement('span', null, '图像能力设置已关闭'),
            React.createElement('button', {
              type: 'button', style: { ...css.ghost, height: 26, padding: '0 10px', fontSize: 12 },
              onClick: () => setClosed(false),
            }, '重新打开'),
          )
        }
        return React.createElement(SetupModal, { credentials: props.credentials, onClose: () => setClosed(true) })
      }
      if (isSetup && !settled) return React.createElement('div', { style: css.inline }, '准备图像能力设置…')
      if (!settled) return React.createElement('div', { style: css.inline }, `image_asset: ${args.action || ''}`)
      return React.createElement('div', { style: css.inline }, text || 'image_asset 已完成')
    }

    const inject = ['slots', 'remote', 'remote.credentials']

    function apply(ctx) {
      const credentials = ctx.remote && ctx.remote.credentials

      ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
        name: 'tool.call.toolview',
        key: 'image_asset',
        inject: () => ({ credentials }),
      }, ImageAssetToolview))

      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'rp-card-image',
        order: 86,
        label: () => '图像能力',
        inject: () => ({ credentials }),
      }, SettingsPanel))
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
