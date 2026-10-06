(() => {
  const $ = id => document.getElementById(id), api = window.ApiPresets;
  const button = $('testConnection'), result = $('connectionResult');
  let active = null, lastSignature = null;
  const signature = () => JSON.stringify(['apiUrl', 'apiModel', 'apiKey'].map(id => $(id).value.trim()).concat($('testVision').checked));
  function report(message, kind = '') {
    result.textContent = message;
    result.className = 'connection-result ' + kind;
  }
  function invalidate() {
    if (lastSignature !== null && signature() === lastSignature) return;
    const hadResult = !!result.textContent;
    if (active) { const previous = active; active = null; clearTimeout(previous.timer); previous.controller.abort(); }
    button.textContent = '测试连接';
    if (hadResult) report('配置已修改，请重新测试。');
  }
  function redact(value, key) {
    let text = String(value || '');
    if (key) text = text.split(key).join('[密钥已隐藏]');
    return text.replace(/Bearer\s+[^\s"<>]+/gi, 'Bearer [已隐藏]').replace(/(?:sk-|AIza)[A-Za-z0-9._-]{12,}/g, '[密钥已隐藏]').replace(/\s+/g, ' ').slice(0, 320);
  }
  function detail(data, raw, key) {
    const error = data?.error;
    const text = typeof error === 'string' ? error : error?.message || error?.msg || data?.message || data?.msg;
    return redact(text || (data ? JSON.stringify(data) : raw.replace(/<[^>]*>/g, ' ')), key);
  }
  function failure(status, reason) {
    if (/SSL|TLS|安全通道|证书/i.test(reason)) return 'HTTPS 安全连接失败，请使用更新后的 EXE，并检查系统时间、证书或 HTTPS 代理。';
    if (status === 401) return '密钥验证失败，请检查密钥是否正确、过期或已被撤销。';
    if (status === 403) return '服务拒绝访问，请检查模型权限、账户状态及服务支持的地区。';
    if (status === 402 || /insufficient_quota|余额|额度不足|欠费|credit.*(?:low|insufficient)|balance/i.test(reason)) return '账户余额或额度不足，请查看服务商账户。';
    if (status === 404) return '接口地址或模型不存在，请核对完整地址和模型 ID。';
    if (status === 429) return '请求受到限流或配额限制，请稍后重试并检查账户额度。';
    if (status === 400 || status === 422) return '请求未被接受，请检查模型名称、图片支持情况及接口参数。';
    if (/超时|timed?\s*out|timeout/i.test(reason) || status === 408 || status === 504) return '服务响应超时，请稍后重试或换用响应更快的模型。';
    if (status >= 500) return '本地代理或模型服务暂时无法完成请求，请根据下方信息检查网络与服务状态。';
    return '模型调用失败，请检查该服务的接口配置。';
  }
  function returnedText(data) {
    const message = data?.choices?.[0]?.message;
    return typeof message?.content === 'string' ? message.content.trim() :
      Array.isArray(message?.content) ? message.content.map(part => part.text || '').join('').trim() : '';
  }
  function sampleImage() {
    // Never upload the user's current manga during a configuration check.
    const digits = String(Math.floor(1000 + Math.random() * 9000));
    const canvas = Object.assign(document.createElement('canvas'), {width: 256, height: 128});
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 256, 128);
    ctx.fillStyle = '#111'; ctx.font = 'bold 64px Arial'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(digits, 128, 64);
    return {digits, url: canvas.toDataURL('image/png')};
  }
  async function test() {
    if (active) {
      const pending = active; active = null; clearTimeout(pending.timer); pending.controller.abort();
      button.textContent = '测试连接'; report('已取消本地等待。已发出的请求仍可能由服务商处理。'); return;
    }
    const config = {url: $('apiUrl').value.trim(), model: $('apiModel').value.trim(), key: $('apiKey').value.trim()};
    if (!config.url || !config.model || !config.key) { report('请先填入接口地址、模型名称和 API 密钥。', 'error'); return; }
    let url; try { url = api.endpoint(config.url); } catch (error) { report(error.message, 'error'); return; }
    const vision = $('testVision').checked;
    if (vision) { const issue = api.modelIssue(config.url, config.model); if (issue) { report(issue + ' 若只测试连接，可取消勾选图片识别。', 'error'); return; } }
    const sample = vision ? sampleImage() : null;
    lastSignature = signature();
    const task = {controller: new AbortController(), timedOut: false, start: performance.now(), timer: null};
    active = task;
    task.timer = setTimeout(() => { task.timedOut = true; task.controller.abort(); }, 60000);
    button.textContent = '取消等待';
    report(vision ? '正在连接并检查图片识别…（最多等待 60 秒）' : '正在测试模型连接…（最多等待 60 秒）', 'pending');
    try {
      const res = await fetch('/api/proxy', {method: 'POST', headers: {'Content-Type': 'application/json'}, signal: task.controller.signal,
        body: JSON.stringify({url, key: config.key, payload: api.testPayload(config, sample?.url)})});
      const raw = await res.text(); if (active !== task) return;
      let data; try { data = JSON.parse(raw); } catch {}
      if (!res.ok || data?.error) {
        const reason = detail(data, raw, config.key);
        report(failure(res.status, reason) + '\nHTTP ' + res.status + (reason ? ' · ' + reason : ''), 'error'); return;
      }
      if (!data || !Array.isArray(data.choices) || !data.choices.length) {
        report('服务返回了响应，但不是有效的模型对话结果。请检查接口地址是否指向兼容的 chat/completions 接口。\nHTTP ' + res.status, 'error'); return;
      }
      const elapsed = ((performance.now() - task.start) / 1000).toFixed(1), text = returnedText(data);
      const summary = `HTTP ${res.status} · ${elapsed} 秒\n请求模型：${config.model}`;
      if (!text) {
        const truncated = data.choices[0]?.finish_reason === 'length';
        report('已连接到模型，但未收到可验证的文字回复。' + (truncated ? '测试输出被截断，可能是模型的思考过程耗尽了输出上限。' : '模型可能拒绝了请求或返回了空内容。') + '\n' + summary, 'warning'); return;
      }
      if (vision) {
        const digits = [...text.replace(/\s+/g, '').matchAll(/(?:^|\D)(\d{4})(?=\D|$)/g)].map(match => match[1]);
        const recognized = digits.includes(sample.digits);
        report((recognized ? '连接成功，测试图片中的数字已正确识别。' : '模型调用成功，但未正确识别测试图。图片识别能力尚未确认，请检查模型选择。') + '\n' + summary + '\n测试回复：' + redact(text, config.key), recognized ? 'success' : 'warning');
      } else report('连接成功，密钥和所选模型已完成一次文字请求。图片识别尚未检查。\n' + summary + '\n测试回复：' + redact(text, config.key), 'success');
    } catch (error) {
      if (active !== task) return;
      if (task.timedOut) report('测试等待超过 60 秒。服务仍可能在处理请求，请稍后重试或换用响应更快的模型。', 'error');
      else if (error.name === 'AbortError') report('测试等待已取消。');
      else report('无法连接本地服务或网络中断。请确认 MangaTranslator.exe 正在运行，再重新测试。\n' + redact(error.message, config.key), 'error');
    } finally {
      clearTimeout(task.timer);
      if (active === task) { active = null; button.textContent = '测试连接'; }
    }
  }
  button.onclick = test;
  ['apiUrl', 'apiModel', 'apiKey'].forEach(id => $(id).addEventListener('input', invalidate));
  $('testVision').addEventListener('change', invalidate);
  window.ConnectionTest = {invalidate};
})();
