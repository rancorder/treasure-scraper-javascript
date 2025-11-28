#!/usr/bin/env node
/**
 * treasure-scraper.js
 * トレジャーファクトリー 1位監視スクレイパー (JavaScript版)
 * 
 * 【30分実装の制約】
 * - Playwright for Node.js使用
 * - 基本機能のみ（1位監視・通知・スナップショット）
 * - エラーハンドリング簡易版
 * - ログは console のみ
 * 
 * 【実装した機能】
 * ✅ Playwright動的スクレイピング
 * ✅ DOM安定化待機
 * ✅ 商品情報抽出（名前・価格・URL・ID）
 * ✅ スナップショット管理（JSON）
 * ✅ ChatWork通知
 * ✅ 重複通知防止
 * ✅ Circuit Breaker（簡易版）
 * ✅ リトライ機構
 */

const { chromium } = require('playwright');
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

// ============================================================
// 設定
// ============================================================

const CONFIG = {
  // URL
  BASE_URL: 'https://ec.treasure-f.com/search?category=1029&category2=1031&size=grid&order=newarrival&number=30&step=1',
  SITE_BASE_URL: 'https://ec.treasure-f.com',
  
  // ChatWork
  CHATWORK_TOKEN: '987cf44efbf5529a09b1317a85058640',
  CHATWORK_ROOM_ID: '414116324',
  
  // タイムアウト
  PAGE_LOAD_TIMEOUT: 90000,
  SELECTOR_TIMEOUT: 30000,
  
  // DOM安定化
  DOM_STABILITY_CHECKS: 3,
  DOM_STABILITY_INTERVAL: 500,
  
  // リトライ
  MAX_RETRIES: 3,
  RETRY_DELAY: 10000,
  
  // Circuit Breaker
  CIRCUIT_BREAKER_THRESHOLD: 5,
  CIRCUIT_BREAKER_TIMEOUT: 300000,
  
  // 監視
  CHECK_INTERVAL: 30000,
  
  // 通知履歴
  NOTIFICATION_COOLDOWN_HOURS: 6,
  
  // ファイル
  SNAPSHOT_FILE: 'treasure_snapshot.json',
  NOTIFICATION_HISTORY_FILE: 'treasure_notification_history.json',
  STATE_FILE: 'treasure_state.json'
};

// ============================================================
// ユーティリティ
// ============================================================

function generateHash(name, price) {
  return crypto.createHash('md5').update(`${name}_${price}`).digest('hex').substring(0, 8);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function log(level, message) {
  const timestamp = new Date().toISOString().replace('T', ' ').substring(0, 19);
  console.log(`${timestamp} [${level}] ${message}`);
}

// ============================================================
// Circuit Breaker
// ============================================================

class CircuitBreaker {
  constructor() {
    this.failureCount = 0;
    this.lastFailureTime = null;
    this.isOpen = false;
    this.loadState();
  }
  
  async loadState() {
    try {
      const data = await fs.readFile(CONFIG.STATE_FILE, 'utf8');
      const state = JSON.parse(data).circuitBreaker || {};
      this.failureCount = state.failureCount || 0;
      this.lastFailureTime = state.lastFailureTime ? new Date(state.lastFailureTime) : null;
      this.isOpen = state.isOpen || false;
    } catch (err) {
      // ファイルなし or パースエラーは無視
    }
  }
  
  async saveState() {
    const state = {
      circuitBreaker: {
        failureCount: this.failureCount,
        lastFailureTime: this.lastFailureTime?.toISOString(),
        isOpen: this.isOpen
      },
      lastUpdated: new Date().toISOString()
    };
    await fs.writeFile(CONFIG.STATE_FILE, JSON.stringify(state, null, 2));
  }
  
  isAvailable() {
    if (!this.isOpen) return true;
    
    if (!this.lastFailureTime) return true;
    
    const elapsed = Date.now() - this.lastFailureTime.getTime();
    if (elapsed >= CONFIG.CIRCUIT_BREAKER_TIMEOUT) {
      log('INFO', '🔄 Circuit Breaker: Half-Open（再試行許可）');
      this.isOpen = false;
      this.saveState();
      return true;
    }
    
    const remaining = Math.floor((CONFIG.CIRCUIT_BREAKER_TIMEOUT - elapsed) / 1000);
    log('WARN', `⛔ Circuit Breaker: Open（処理スキップ、残り${remaining}秒）`);
    return false;
  }
  
  async recordSuccess() {
    if (this.failureCount > 0 || this.isOpen) {
      log('INFO', '✅ Circuit Breaker: Closed（正常復帰）');
    }
    this.failureCount = 0;
    this.lastFailureTime = null;
    this.isOpen = false;
    await this.saveState();
  }
  
  async recordFailure() {
    this.failureCount++;
    this.lastFailureTime = new Date();
    
    if (this.failureCount >= CONFIG.CIRCUIT_BREAKER_THRESHOLD) {
      if (!this.isOpen) {
        log('ERROR', `🚨 Circuit Breaker: Open（連続失敗${this.failureCount}回）`);
        this.isOpen = true;
      }
    } else {
      log('WARN', `⚠️ Circuit Breaker: 失敗記録 ${this.failureCount}/${CONFIG.CIRCUIT_BREAKER_THRESHOLD}回`);
    }
    
    await this.saveState();
  }
}

// ============================================================
// 通知履歴管理
// ============================================================

class NotificationHistory {
  constructor() {
    this.history = [];
    this.loadHistory();
  }
  
  async loadHistory() {
    try {
      const data = await fs.readFile(CONFIG.NOTIFICATION_HISTORY_FILE, 'utf8');
      this.history = JSON.parse(data).history || [];
      log('INFO', `通知履歴読み込み: ${this.history.length}件`);
    } catch (err) {
      this.history = [];
    }
  }
  
  async saveHistory() {
    const data = {
      cooldownHours: CONFIG.NOTIFICATION_COOLDOWN_HOURS,
      lastUpdated: new Date().toISOString(),
      history: this.history
    };
    await fs.writeFile(CONFIG.NOTIFICATION_HISTORY_FILE, JSON.stringify(data, null, 2));
  }
  
  shouldNotify(hash, name) {
    const now = Date.now();
    const cooldownMs = CONFIG.NOTIFICATION_COOLDOWN_HOURS * 3600 * 1000;
    
    for (const record of this.history) {
      if (record.hash === hash) {
        const notifiedAt = new Date(record.notifiedAt).getTime();
        const elapsed = now - notifiedAt;
        
        if (elapsed < cooldownMs) {
          const remainingHours = ((cooldownMs - elapsed) / 3600000).toFixed(1);
          log('INFO', `⏸️  重複通知防止: ${name.substring(0, 40)}... (残り${remainingHours}時間)`);
          return false;
        }
      }
    }
    
    return true;
  }
  
  async addNotification(product) {
    this.history.push({
      hash: product.hash,
      name: product.name,
      price: product.price,
      notifiedAt: new Date().toISOString(),
      itemId: product.itemId,
      itemUrl: product.itemUrl
    });
    
    // 古い履歴を削除（最新100件のみ保持）
    if (this.history.length > 100) {
      this.history = this.history.slice(-100);
    }
    
    await this.saveHistory();
  }
}

// ============================================================
// スクレイピング
// ============================================================

async function waitForDynamicContent(page) {
  log('INFO', '⏳ JavaScript並び替え待機中...');
  await sleep(3000);
  
  log('INFO', '⏳ DOM安定化確認中...');
  let stableCount = 0;
  let lastCount = 0;
  
  for (let i = 0; i < 15; i++) {
    const items = await page.$$('li.pj-search_item');
    const currentCount = items.length;
    
    if (currentCount === lastCount && currentCount > 0) {
      stableCount++;
      log('INFO', `   ✓ 安定: ${stableCount}/${CONFIG.DOM_STABILITY_CHECKS}回 (商品数=${currentCount})`);
      
      if (stableCount >= CONFIG.DOM_STABILITY_CHECKS) {
        log('INFO', '✅ DOM安定化確認完了');
        return true;
      }
    } else {
      if (stableCount > 0) {
        log('INFO', `   ⚠ 変動検知: リセット (${lastCount}→${currentCount})`);
      }
      stableCount = 0;
    }
    
    lastCount = currentCount;
    await sleep(CONFIG.DOM_STABILITY_INTERVAL);
  }
  
  if (lastCount > 0) {
    log('WARN', `⚠️ DOM完全安定化せず、商品数${lastCount}件で続行`);
    return true;
  }
  
  return false;
}

async function extractProduct(item, index) {
  try {
    // 商品詳細URL・ID取得
    let itemId = '';
    let itemUrl = '';
    const linkElement = await item.$('a.cm-itemlist_itemcode_link');
    if (linkElement) {
      const href = await linkElement.getAttribute('href');
      if (href) {
        const match = href.match(/\/item\/(\d+)/);
        if (match) {
          itemId = match[1];
          itemUrl = `${CONFIG.SITE_BASE_URL}${href}`;
        }
      }
    }
    
    // 商品名取得
    let name = '';
    const imgElement = await item.$('img');
    if (imgElement) {
      name = await imgElement.getAttribute('alt') || '';
    }
    
    // 画像URL取得
    let imgUrl = '';
    if (imgElement) {
      imgUrl = await imgElement.getAttribute('src') || await imgElement.getAttribute('data-src') || '';
      if (imgUrl && !imgUrl.startsWith('http')) {
        imgUrl = `${CONFIG.SITE_BASE_URL}${imgUrl}`;
      }
    }
    
    // 価格取得
    let price = '0';
    const priceContainer = await item.$('.cm-itemlist_price');
    if (priceContainer) {
      const priceText = await priceContainer.innerText();
      const match = priceText.match(/[\d,]+/);
      if (match) {
        price = match[0].replace(/,/g, '');
      }
    }
    
    // 店舗名取得
    let storeName = '';
    const storeTag = await item.$('.cm-tag_store_free');
    if (storeTag) {
      storeName = await storeTag.innerText();
    }
    
    // バリデーション
    if (!name || name.length <= 3) {
      log('ERROR', `❌ 商品名が不正: '${name}' (インデックス: ${index})`);
      return null;
    }
    
    if (price === '0') {
      log('ERROR', `❌ 価格が不正 (インデックス: ${index})`);
      return null;
    }
    
    const fullName = storeName ? `${name} [${storeName}]` : name;
    
    return {
      name: fullName,
      price,
      imgUrl,
      itemId,
      itemUrl,
      storeName,
      hash: generateHash(fullName, price),
      scrapedAt: new Date().toISOString()
    };
  } catch (err) {
    log('ERROR', `❌ 商品情報抽出エラー (インデックス: ${index}): ${err.message}`);
    return null;
  }
}

async function scrapeProducts(limit = null) {
  log('INFO', '=' .repeat(60));
  log('INFO', `📋 上位商品取得開始 (limit=${limit || '全て'})`);
  log('INFO', '='.repeat(60));
  
  for (let attempt = 1; attempt <= CONFIG.MAX_RETRIES; attempt++) {
    let browser = null;
    
    try {
      if (attempt > 1) {
        log('INFO', `🔄 リトライ ${attempt}/${CONFIG.MAX_RETRIES}`);
      }
      
      browser = await chromium.launch({ headless: true });
      const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      });
      const page = await context.newPage();
      
      log('INFO', `🌐 ページ読み込み中...`);
      await page.goto(CONFIG.BASE_URL, {
        timeout: CONFIG.PAGE_LOAD_TIMEOUT,
        waitUntil: 'load'
      });
      
      log('INFO', '⏳ 商品リスト表示待機中...');
      await page.waitForSelector('li.pj-search_item', {
        timeout: CONFIG.SELECTOR_TIMEOUT
      });
      
      if (!await waitForDynamicContent(page)) {
        throw new Error('動的コンテンツ待機失敗');
      }
      
      const items = await page.$$('li.pj-search_item');
      if (items.length === 0) {
        throw new Error('商品要素が見つかりません');
      }
      
      const products = [];
      const maxItems = limit || items.length;
      
      for (let i = 0; i < Math.min(maxItems, items.length); i++) {
        const product = await extractProduct(items[i], i);
        if (product) {
          products.push(product);
          log('INFO', `   [${i+1}位] ${product.name.substring(0, 50)}... ¥${product.price} (ID: ${product.itemId})`);
        }
      }
      
      await browser.close();
      
      if (products.length === 0) {
        throw new Error('商品情報抽出失敗');
      }
      
      log('INFO', '='.repeat(60));
      log('INFO', `✅ 商品取得成功: ${products.length}件`);
      log('INFO', '='.repeat(60));
      
      return products;
      
    } catch (err) {
      log('ERROR', `❌ スクレイピングエラー (試行${attempt}/${CONFIG.MAX_RETRIES}): ${err.message}`);
      
      if (browser) {
        try {
          await browser.close();
        } catch (e) {
          // 無視
        }
      }
      
      if (attempt < CONFIG.MAX_RETRIES) {
        await sleep(CONFIG.RETRY_DELAY);
      }
    }
  }
  
  log('ERROR', `❌ ${CONFIG.MAX_RETRIES}回リトライしましたが失敗`);
  return [];
}

// ============================================================
// スナップショット管理
// ============================================================

async function loadSnapshot() {
  try {
    const data = await fs.readFile(CONFIG.SNAPSHOT_FILE, 'utf8');
    const json = JSON.parse(data);
    return json.top1 || null;
  } catch (err) {
    log('INFO', 'スナップショットファイルなし（初回実行）');
    return null;
  }
}

async function saveSnapshot(product) {
  const data = {
    timestamp: new Date().toISOString(),
    top1: product
  };
  await fs.writeFile(CONFIG.SNAPSHOT_FILE, JSON.stringify(data, null, 2));
  log('INFO', `スナップショット保存: ${product.name.substring(0, 30)}... (ID: ${product.itemId})`);
}

// ============================================================
// 通知
// ============================================================

async function sendChatWorkNotification(product) {
  try {
    log('INFO', `📤 ChatWork通知送信開始`);
    
    const scrapedTime = new Date(product.scrapedAt).toLocaleTimeString('ja-JP');
    
    let message = '[info]';
    message += '━━━━━━━━━━━━━━━━━\n';
    message += '🔍 トレジャーファクトリー + 新着\n';
    message += '━━━━━━━━━━━━━━━━━\n';
    message += `🔗 ${CONFIG.BASE_URL}\n`;
    message += '━━━━━━━━━━━━━━━━━\n\n';
    message += `■ ${product.name}・${product.price}円\n\n`;
    
    if (product.itemUrl) {
      message += `📦 商品詳細: ${product.itemUrl}\n`;
    }
    if (product.itemId) {
      message += `🆔 商品ID: ${product.itemId}\n`;
    }
    message += `⏰ 取得時刻: ${scrapedTime}\n`;
    message += '\nーーーーーーーーーー[/info]';
    
    const fetch = (await import('node-fetch')).default;
    const response = await fetch(
      `https://api.chatwork.com/v2/rooms/${CONFIG.CHATWORK_ROOM_ID}/messages`,
      {
        method: 'POST',
        headers: {
          'X-ChatWorkToken': CONFIG.CHATWORK_TOKEN,
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: `body=${encodeURIComponent(message)}`
      }
    );
    
    if (response.ok) {
      log('INFO', '✅ ChatWork通知送信成功');
      return true;
    } else {
      log('ERROR', `❌ ChatWork通知送信失敗: ${response.status}`);
      return false;
    }
  } catch (err) {
    log('ERROR', `❌ ChatWork通知エラー: ${err.message}`);
    return false;
  }
}

// ============================================================
// メイン処理
// ============================================================

async function checkAndNotify(notificationHistory, circuitBreaker) {
  if (!circuitBreaker.isAvailable()) {
    return false;
  }
  
  try {
    const oldTop1 = await loadSnapshot();
    
    if (oldTop1) {
      log('INFO', '='.repeat(60));
      log('INFO', '📖 前回の1位商品:');
      log('INFO', `   ${oldTop1.name.substring(0, 70)}`);
      log('INFO', `   ¥${oldTop1.price} (ID: ${oldTop1.itemId})`);
      log('INFO', '='.repeat(60));
    } else {
      log('INFO', '📖 前回の1位商品: なし（初回実行）');
    }
    
    const products = await scrapeProducts(30);
    
    if (products.length === 0) {
      log('ERROR', '❌ 商品取得失敗');
      await circuitBreaker.recordFailure();
      return false;
    }
    
    await circuitBreaker.recordSuccess();
    
    const currentTop1 = products[0];
    
    if (!oldTop1) {
      log('INFO', '='.repeat(60));
      log('INFO', '🎉 初回実行: 1位を登録');
      log('INFO', `   ${currentTop1.name.substring(0, 80)}`);
      log('INFO', `   ¥${currentTop1.price} (ID: ${currentTop1.itemId})`);
      log('INFO', '='.repeat(60));
      await saveSnapshot(currentTop1);
      log('INFO', 'ℹ️  初回実行のため通知はスキップ');
      return true;
    }
    
    // 前回1位より上位の商品を検出
    const newTopProducts = [];
    let oldTop1Found = false;
    
    for (let i = 0; i < products.length; i++) {
      if (products[i].hash === oldTop1.hash) {
        oldTop1Found = true;
        log('INFO', `   前回1位発見: [${i+1}位] ${products[i].name.substring(0, 60)}`);
        break;
      } else {
        newTopProducts.push(products[i]);
      }
    }
    
    if (!oldTop1Found) {
      log('INFO', '='.repeat(60));
      log('INFO', '🎉 前回1位が圏外に! 現在の1位を通知');
      log('INFO', '='.repeat(60));
      newTopProducts.length = 0;
      newTopProducts.push(currentTop1);
    }
    
    if (newTopProducts.length > 0) {
      log('INFO', '='.repeat(60));
      log('INFO', `🎉 上位変動検知! ${newTopProducts.length}件の新商品`);
      log('INFO', '='.repeat(60));
      
      let notifiedCount = 0;
      for (let i = 0; i < newTopProducts.length; i++) {
        const product = newTopProducts[i];
        log('INFO', `\n[${i+1}/${newTopProducts.length}] 通知チェック:`);
        log('INFO', `   ${product.name.substring(0, 70)}`);
        
        if (notificationHistory.shouldNotify(product.hash, product.name)) {
          const success = await sendChatWorkNotification(product);
          if (success) {
            await notificationHistory.addNotification(product);
            notifiedCount++;
            log('INFO', '   ✅ 通知送信成功');
          } else {
            log('WARN', '   ⚠️ 通知送信失敗');
          }
        }
      }
      
      log('INFO', '='.repeat(60));
      log('INFO', `📤 通知完了: ${notifiedCount}/${newTopProducts.length}件送信`);
      log('INFO', '='.repeat(60));
      
      await saveSnapshot(currentTop1);
      return true;
    } else {
      log('INFO', '✅ 上位変動なし');
      
      if (currentTop1.hash !== oldTop1.hash) {
        log('INFO', `   ※1位が変更されました`);
        await saveSnapshot(currentTop1);
      }
      
      return true;
    }
  } catch (err) {
    log('ERROR', `❌ checkAndNotifyエラー: ${err.message}`);
    await circuitBreaker.recordFailure();
    return false;
  }
}

async function main() {
  log('INFO', '┏' + '━'.repeat(58) + '┓');
  log('INFO', '🚀 トレジャーファクトリー 1位監視 JavaScript版 起動');
  log('INFO', '┗' + '━'.repeat(58) + '┛');
  log('INFO', '⚙️  設定:');
  log('INFO', `   - チェック間隔: ${CONFIG.CHECK_INTERVAL/1000}秒`);
  log('INFO', `   - 重複通知防止: ${CONFIG.NOTIFICATION_COOLDOWN_HOURS}時間`);
  log('INFO', `   - リトライ: ${CONFIG.MAX_RETRIES}回`);
  log('INFO', '┏' + '━'.repeat(58) + '┛\n');
  
  const notificationHistory = new NotificationHistory();
  const circuitBreaker = new CircuitBreaker();
  
  let loopCount = 0;
  
  while (true) {
    try {
      loopCount++;
      log('INFO', '\n' + '='.repeat(60));
      log('INFO', `🔄 ループ ${loopCount} 開始 - ${new Date().toLocaleString('ja-JP')}`);
      log('INFO', '='.repeat(60));
      
      await checkAndNotify(notificationHistory, circuitBreaker);
      
      log('INFO', `⏰ 次回チェックまで ${CONFIG.CHECK_INTERVAL/1000}秒待機...\n`);
      await sleep(CONFIG.CHECK_INTERVAL);
      
    } catch (err) {
      log('ERROR', `❌ メインループエラー: ${err.message}`);
      await sleep(CONFIG.RETRY_DELAY);
    }
  }
}

// 実行
if (require.main === module) {
  main().catch(err => {
    log('ERROR', `❌ 致命的エラー: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { scrapeProducts, checkAndNotify };