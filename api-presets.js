(() => {
  // Official interface examples checked on 2026-10-06. Model access depends
  // on the account; fields remain editable when an alias changes or retires.
  const templates = [
    {
      id: 'custom', name: '自定义 · OpenAI 兼容接口', url: '', model: '',
      models: [], docs: '',
      note: '填写自己的接口地址和支持图片输入的模型。支持完整 chat/completions 地址或兼容接口的基础地址。'
    },
    {
      id: 'openai', name: 'ChatGPT / OpenAI', url: 'https://api.openai.com/v1',
      model: 'gpt-4.1-mini', models: ['gpt-4.1-mini'],
      docs: 'https://developers.openai.com/api/docs/models/gpt-4.1-mini',
      note: '使用 OpenAI API 平台生成的密钥。示例模型支持图片输入，也可手动填写你的账户可用的其他视觉模型 ID。'
    },
    {
      id: 'gemini', name: 'Gemini · Google AI',
      url: 'https://generativelanguage.googleapis.com/v1beta/openai',
      model: 'gemini-3.8-flash', models: ['gemini-3.8-flash'],
      docs: 'https://ai.google.dev/gemini-api/docs/openai',
      note: '使用 Google AI Studio 的 Gemini API 密钥。模板使用官方兼容接口；需要本机网络能连接 Google 服务。'
    },
    {
      id: 'deepseek', name: 'DeepSeek · 官方接口', url: 'https://api.deepseek.com',
      model: 'deepseek-flash', models: ['deepseek-flash'],
      docs: 'https://api-docs.deepseek.com/guides/vision/',
      note: '使用 DeepSeek 官方平台密钥，示例为官方当前支持图片输入的 deepseek-flash。第三方平台的同名模型请按该平台填写。'
    },
    {
      id: 'qwen', name: 'Qwen · 阿里云百炼（北京）',
      url: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      model: 'qwen3-vl-plus', models: ['qwen3-vl-plus'],
      docs: 'https://help.aliyun.com/en/model-studio/qwen-vl-compatible-with-openai',
      note: '使用百炼北京地域密钥。其他地域或业务空间请修改为对应地址，模型选择支持图片输入的 Qwen-VL。'
    },
    {
      id: 'zhipu', name: '智谱 · GLM', url: 'https://open.bigmodel.cn/api/paas/v4',
      model: 'glm-4.6v', models: ['glm-4.6v'],
      docs: 'https://docs.bigmodel.cn/cn/guide/models/vlm/glm-4.6v',
      note: '使用智谱开放平台 API 密钥与视觉模型。示例 GLM-4.6V 支持图片；服务地址保留 /api/paas/v4。'
    },
    {
      id: 'siliconflow', name: 'SiliconFlow · 硅基流动', url: 'https://api.siliconflow.cn/v1',
      model: 'Qwen/Qwen2.5-VL-72B-Instruct', models: ['Qwen/Qwen2.5-VL-72B-Instruct'],
      docs: 'https://docs.siliconflow.cn/docs/userguide/capabilities/multimodal-vision',
      note: '使用硅基流动密钥，并复制平台完整模型 ID。示例来自官方视觉调用文档，可用模型以你的账户模型广场为准。'
    }
  ];
  const get = id => templates.find(p => p.id === id) || templates[0];
  function infer(value) {
    let u; try { u = new URL(value); } catch { return 'custom'; }
    const host = u.hostname.toLowerCase();
    if (host === 'api.openai.com') return 'openai';
    if (host === 'generativelanguage.googleapis.com') return 'gemini';
    if (host === 'api.deepseek.com') return 'deepseek';
    if (host === 'dashscope.aliyuncs.com' || host === 'dashscope-intl.aliyuncs.com' || host.endsWith('.maas.aliyuncs.com')) return 'qwen';
    if (host === 'open.bigmodel.cn') return 'zhipu';
    if (host === 'api.siliconflow.cn' || host === 'api.siliconflow.com') return 'siliconflow';
    return 'custom';
  }
  function endpoint(value) {
    let u; try { u = new URL(String(value || '').trim()); } catch { throw Error('接口地址无效，请填写完整的 http:// 或 https:// 地址。'); }
    if (!/^https?:$/.test(u.protocol)) throw Error('接口地址必须使用 http:// 或 https://。');
    const path = u.pathname.replace(/\/+$/, '');
    if (/\/chat\/completions$/i.test(path)) u.pathname = path;
    else if (!path) u.pathname = infer(u.href) === 'deepseek' ? '/chat/completions' : '/v1/chat/completions';
    else if (path === '/v1beta' && infer(u.href) === 'gemini') u.pathname = '/v1beta/openai/chat/completions';
    else u.pathname = path + '/chat/completions';
    return u.href;
  }
  function modelIssue(url, model) {
    const provider = infer(url), id = String(model || '').trim();
    if (provider === 'siliconflow' && /^(?:Pro\/)?deepseek-ai\/DeepSeek-(?:V3(?:\.\d+)?|R1)(?:$|-)/i.test(id))
      return '此 DeepSeek V3/R1 是文本模型，不能识别漫画图片。请使用硅基流动支持图片输入的模型，例如 Qwen/Qwen2.5-VL-72B-Instruct。';
    if (provider === 'deepseek' && id === 'deepseek-v4-pro')
      return '此 DeepSeek 模型不支持图片。可选择官方视觉模型 deepseek-flash，或填写官方提供的其他视觉模型 ID。';
    if (provider === 'deepseek' && /^(deepseek-chat|deepseek-reasoner)$/i.test(id))
      return '此旧模型 ID 已停用。请使用官方当前支持图片输入的模型，例如 deepseek-flash。';
    return '';
  }
  function requestPayload(config, content, limit) {
    const body = {model: config.model, stream: false, messages: [{role: 'user', content}]};
    // OpenAI reasoning models reject legacy max_tokens and fixed temperature.
    if (/^(?:gpt-[5-9](?:[.-]|$)|o[1-9](?:[.-]|$))/i.test(config.model)) body.max_completion_tokens = limit;
    else { body.max_tokens = limit; body.temperature = .1; }
    return body;
  }
  function payload(config, prompt, base64) {
    const provider = infer(config.url);
    const image = {url: 'data:image/jpeg;base64,' + base64};
    if (['openai', 'custom', 'siliconflow'].includes(provider)) image.detail = 'high';
    return requestPayload(config, [{type: 'text', text: prompt}, {type: 'image_url', image_url: image}], 7000);
  }
  function testPayload(config, imageUrl) {
    const provider = infer(config.url);
    const content = imageUrl ? [{type: 'text', text: '读取图片正中的四位数字，只回复这四位数字，不要解释。'},
      {type: 'image_url', image_url: {url: imageUrl}}] : '连接测试。请只回复 OK，不要解释。';
    const reasoning = /^(?:gpt-[5-9](?:[.-]|$)|o[1-9](?:[.-]|$))/i.test(config.model);
    const body = requestPayload(config, content, ['gemini', 'zhipu'].includes(provider) ? 2048 : reasoning ? 1024 : 128);
    if (provider === 'gemini') body.reasoning_effort = 'low';
    if (provider === 'deepseek') body.thinking = {type: 'disabled'};
    return body;
  }
  window.ApiPresets = {templates, get, infer, endpoint, modelIssue, payload, testPayload};
})();
