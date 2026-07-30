const test = require('node:test');
const assert = require('node:assert/strict');

const AiService = require('../src/aiService');
const { ProductService } = require('../src/productService');

function product(id, name, type) {
  return {
    id,
    name,
    type,
    brand: 'Promax',
    tags: type,
    images: [`https://cdn.example/${id}.jpg`],
    variants: [{
      id: `${id}-v1`,
      sku: `${id}-sku`,
      quantity: 5,
      inStock: true,
      price: 1200000
    }]
  };
}

function createServices() {
  const products = new ProductService('', 'https://shop.example', { loadCsv: false });
  products.replaceProducts([
    product('pickle-racket', 'Vợt Pickleball Promax P1', 'Vợt Pickleball'),
    product('badminton-racket', 'Vợt Cầu Lông Promax B1', 'Vợt Cầu Lông'),
    product('volleyball-shoe', 'Giày Bóng Chuyền Promax V1', 'Giày Bóng Chuyền')
  ]);
  const ai = new AiService({
    baseUrl: 'https://ai.example',
    token: 'test-token',
    routerModel: 'test-haiku',
    chatModel: 'test-haiku',
    messagesPath: '/v1/messages',
    authMode: 'bearer',
    style: 'anthropic',
    routerMaxTokens: 800,
    routerAlways: true,
    routerHistoryMessages: 6,
    routerHistoryChars: 500,
    maxCandidates: 5,
    productFinalEnabled: false,
    cacheTtlMs: 60000
  }, products);
  return { ai, products };
}

function racketRequirement() {
  return [{ label: 'Loại sản phẩm: Vợt', terms: ['vợt'], scope: 'identity' }];
}

test('bộ huấn luyện router có taxonomy, lỗi gõ pcik và câu trả lời ngân sách mở', () => {
  const { ai } = createServices();
  const prompt = ai.buildRouterSystemPrompt();

  assert.match(prompt, /racket=\[cầu lông, tennis, pickleball, bóng bàn\]/i);
  assert.match(prompt, /pcik.*pickleball/i);
  assert.match(prompt, /bao nhiêu cũng được/i);
  assert.match(prompt, /consultation.*pendingField/i);
});

test('AI tự sửa câu hỏi vô lý “vợt bóng chuyền” trước khi trả cho khách', async () => {
  const { ai } = createServices();
  const prompts = [];
  ai.call = async ({ messages, purpose }) => {
    prompts.push({ purpose, content: messages[0].content });
    if (purpose === 'router') {
      return JSON.stringify({
        intent: 'search_product',
        needDatabase: true,
        showProducts: false,
        responseMode: 'clarify',
        clarificationQuestion: 'Bạn cần vợt cho bóng đá, chạy bộ, bóng chuyền, cầu lông hay pickleball?',
        consultation: { ready: false, pendingField: 'sport' },
        search: {
          query: 'mua vợt',
          requirements: racketRequirement()
        }
      });
    }
    return JSON.stringify({
      intent: 'search_product',
      needDatabase: true,
      showProducts: false,
      responseMode: 'clarify',
      clarificationQuestion: 'Bạn muốn tìm vợt cầu lông, tennis, pickleball hay bóng bàn?',
      consultation: { ready: false, pendingField: 'sport' },
      search: {
        query: 'mua vợt',
        requirements: racketRequirement()
      }
    });
  };

  const route = await ai.route('mua vợt');

  assert.equal(prompts.length, 2);
  assert.equal(prompts[1].purpose, 'router-repair');
  assert.match(prompts[1].content, /ghép vợt với bộ môn không sử dụng vợt/i);
  assert.equal(route._source, 'ai-router-repair');
  assert.equal(route.showProducts, false);
  assert.equal(route.consultation.pendingField, 'sport');
  assert.match(route.clarificationQuestion, /cầu lông.*tennis.*pickleball.*bóng bàn/i);
  assert.doesNotMatch(route.clarificationQuestion, /bóng đá|chạy bộ|bóng chuyền|bóng rổ/i);
});

test('AI hiểu “pcik đi” theo câu hỏi vợt trước đó và code chỉ truy vấn đúng sản phẩm', async () => {
  const { ai, products } = createServices();
  const previousRoute = ai.fallbackRoute('mua vợt');
  const history = [
    { role: 'user', text: 'mua vợt' },
    {
      role: 'assistant',
      text: previousRoute.clarificationQuestion,
      route: previousRoute
    }
  ];
  let routerPrompt = '';
  ai.call = async ({ messages }) => {
    routerPrompt = messages[0].content;
    return JSON.stringify({
      intent: 'search_product',
      needDatabase: true,
      showProducts: true,
      responseMode: 'brief',
      clarificationQuestion: '',
      consultation: { ready: true, pendingField: '' },
      search: {
        query: 'vợt pickleball',
        categories: ['pickleball'],
        customerNeeds: ['Vợt pickleball'],
        requirements: racketRequirement(),
        flexibleFields: []
      }
    });
  };

  const route = await ai.route('pcik đi', history);
  const results = products.queryByPlan(route, 'pcik đi', 5);

  assert.match(routerPrompt, /"pendingField":"sport"/);
  assert.match(routerPrompt, /pcik.*pickleball/i);
  assert.equal(route._source, 'ai-router');
  assert.equal(route.showProducts, true);
  assert.equal(route.consultation.ready, true);
  assert.ok(route.search.categories.some((category) => /pickleball/i.test(category)));
  assert.deepEqual(results.map((item) => item.id), ['pickle-racket']);
});

test('“bao nhiêu cũng được” được coi là ngân sách mở và không lặp câu hỏi', async () => {
  const { ai } = createServices();
  const previousRoute = {
    intent: 'search_product',
    needDatabase: true,
    needWeb: false,
    showProducts: false,
    responseMode: 'clarify',
    clarificationQuestion: 'Khoảng ngân sách bạn muốn chọn là bao nhiêu?',
    consultation: { ready: false, pendingField: 'budget' },
    search: {
      query: 'vợt pickleball',
      categories: ['pickleball'],
      requirements: racketRequirement(),
      customerNeeds: ['Vợt pickleball'],
      flexibleFields: [],
      minPrice: null,
      maxPrice: null
    }
  };
  const history = [
    { role: 'user', text: 'pick' },
    {
      role: 'assistant',
      text: previousRoute.clarificationQuestion,
      route: previousRoute
    }
  ];
  let calls = 0;
  ai.call = async ({ purpose }) => {
    calls += 1;
    if (purpose === 'router') {
      return JSON.stringify({
        ...previousRoute,
        consultation: { ready: false, pendingField: 'budget' }
      });
    }
    return JSON.stringify({
      intent: 'search_product',
      needDatabase: true,
      showProducts: true,
      responseMode: 'brief',
      clarificationQuestion: '',
      consultation: { ready: true, pendingField: '' },
      search: {
        query: 'vợt pickleball không giới hạn ngân sách',
        categories: ['pickleball'],
        requirements: racketRequirement(),
        customerNeeds: ['Vợt pickleball', 'Không giới hạn ngân sách'],
        flexibleFields: ['budget'],
        minPrice: null,
        maxPrice: null
      }
    });
  };

  const route = await ai.route('bao nhiêu cũng được', history);

  assert.equal(calls, 2);
  assert.equal(route._source, 'ai-router-repair');
  assert.equal(route.showProducts, true);
  assert.equal(route.responseMode, 'brief');
  assert.equal(route.consultation.ready, true);
  assert.deepEqual(route.search.flexibleFields, ['budget']);
  assert.equal(route.search.minPrice, null);
  assert.equal(route.search.maxPrice, null);
  assert.equal(route.clarificationQuestion, '');
});

test('fallback khi AI mất kết nối cũng không gợi ý vợt cho môn không dùng vợt', () => {
  const { ai } = createServices();
  const route = ai.fallbackRoute('mua vợt');

  assert.equal(route.responseMode, 'clarify');
  assert.match(route.clarificationQuestion, /cầu lông.*tennis.*pickleball.*bóng bàn/i);
  assert.doesNotMatch(route.clarificationQuestion, /bóng đá|chạy bộ|bóng chuyền|bóng rổ/i);
});
