/**
 * note-suki for GAS — note.com の公開スキ数を Google スプレッドシートに日次集計する。
 * Apps Script 単体で完結（外部サービス・ライブラリ不要）。
 *
 * ⚠️ 非公式・note 公式とは無関係。公開ページの非公式 API を「読み取りのみ・認証なし」で叩く。
 *    ログイン/投稿/改変は一切しない。利用は自己責任で note 利用規約を各自確認すること。
 *
 * セットアップ:
 *   1) Google スプレッドシートを新規作成
 *   2) 拡張機能 → Apps Script を開き、このファイルを貼り付けて保存
 *   3) プロジェクトの設定 → スクリプト プロパティ に NOTE_URLNAME を追加
 *      例: NOTE_URLNAME = your_urlname   （Slack も使うなら SLACK_WEBHOOK_URL も）
 *   4) シートに戻ってメニュー「note-suki」→「今すぐ集計」（初回は権限承認）
 *   5)「note-suki」→「毎日6時に自動実行」で日次トリガー設定
 *   ※ プロジェクトのタイムゾーンを Asia/Tokyo にしておくこと（毎朝6時 = JST）
 *
 * 社内共有: スプレッドシートの「共有」で会社ドメイン or 特定の人に共有するだけ。
 *           パスワード基盤は不要（Google アカウント認証）。
 */

var UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
var SHEET_ARTICLES = '記事';
var SHEET_HISTORY = '日次履歴';
var SHEET_SUMMARY = 'サマリ';
var SHEET_TREND = '記事推移'; // 記事を選んで日時推移を見るインタラクティブシート
var SHEET_HIST = '_記事別履歴'; // SPARKLINE / 記事推移 の元データ（隠しシート）
var LIKE_COLOR = '#ff6b8b';

// ===== メニュー =====
function onOpen() {
  // スプレッドシートを開いた時に自動で呼ばれ、メニューを作る。
  // ※ エディタから手動実行すると UI コンテキストが無く getUi() が例外になる。
  //    手動で動かしたいのは onOpen ではなく dailySnapshot。
  try {
    SpreadsheetApp.getUi()
      .createMenu('note-suki')
      .addItem('今すぐ集計', 'dailySnapshot')
      .addItem('毎日6時に自動実行を設定', 'setupTrigger')
      .addToUi();
  } catch (e) {
    // UI の無いコンテキスト（手動実行・トリガー等）では何もしない
  }
}

function prop_(key) {
  return PropertiesService.getScriptProperties().getProperty(key);
}
function urlname_() {
  var u = prop_('NOTE_URLNAME');
  if (!u) throw new Error('スクリプト プロパティ NOTE_URLNAME を設定してください（例: your_urlname）');
  return String(u).trim();
}
function tokyoDate_(d) {
  return Utilities.formatDate(d || new Date(), 'Asia/Tokyo', 'yyyy-MM-dd');
}
// セル値が Date 型(Sheetsの自動日付化)でも文字列でも yyyy-MM-dd に正規化。日付でなければ null
function normDate_(v) {
  if (Object.prototype.toString.call(v) === '[object Date]') {
    return Utilities.formatDate(v, 'Asia/Tokyo', 'yyyy-MM-dd');
  }
  var s = String(v);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

// ===== note 非公式 API =====
function noteGet_(path) {
  var res = UrlFetchApp.fetch('https://note.com/api' + path, {
    headers: { 'User-Agent': UA, 'Accept': 'application/json' },
    muteHttpExceptions: true
  });
  var code = res.getResponseCode();
  if (code !== 200) throw new Error('note API ' + code + ' (' + path + ')');
  return JSON.parse(res.getContentText());
}
function fetchCreator_(urlname) {
  return noteGet_('/v2/creators/' + encodeURIComponent(urlname)).data || {};
}
function fetchArticles_(urlname) {
  var page = 1, all = [];
  while (page <= 2000) {
    var data = noteGet_('/v2/creators/' + encodeURIComponent(urlname) +
      '/contents?kind=note&page=' + page).data || {};
    var contents = data.contents || [];
    for (var i = 0; i < contents.length; i++) all.push(contents[i]);
    if (data.isLastPage === true || contents.length === 0) break;
    page++;
    Utilities.sleep(600); // 負荷配慮
  }
  return all;
}
function sumBy_(arr, f) { var s = 0; for (var i = 0; i < arr.length; i++) s += f(arr[i]) || 0; return s; }

// ===== メイン =====
function dailySnapshot() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var urlname = urlname_();
  var today = tokyoDate_();

  var creator = fetchCreator_(urlname);
  var articles = fetchArticles_(urlname);
  articles.sort(function (a, b) { return (b.likeCount || 0) - (a.likeCount || 0); });

  // 記事別履歴(_記事別履歴シート)に今日の値をマージ → SPARKLINE の元データ
  var merged = writeHistSheet_(ss, articles, readHistSheet_(ss), today);

  writeArticlesSheet_(ss, articles, merged.dates);
  writeArticleTrendSheet_(ss, articles, merged.dates);
  writeHistorySheet_(ss, creator, articles, today);
  writeSummarySheet_(ss, creator, articles, today);
  postSlack_(creator, articles);

  ss.toast('集計完了: 総スキ ' + sumBy_(articles, function (a) { return a.likeCount; }) +
    ' / ' + articles.length + '記事', 'note-suki', 5);
}

// ===== _記事別履歴（SPARKLINE 元データ・隠しシート） =====
// 形: 行1 = [key, title, 日付1, 日付2, ...] / 各行 = [key, title, 値, 値, ...]
function readHistSheet_(ss) {
  var sh = ss.getSheetByName(SHEET_HIST);
  var hist = {}, titles = {}, dates = [];
  if (!sh || sh.getLastRow() < 1 || sh.getLastColumn() < 2) return { hist: hist, titles: titles, dates: dates };
  var vals = sh.getRange(1, 1, sh.getLastRow(), sh.getLastColumn()).getValues();
  var header = vals[0];
  // 列index -> 正規化日付（Date型に化けていても拾う＝これが前回の修正点）
  var colDate = {};
  for (var c = 2; c < header.length; c++) {
    var ds = normDate_(header[c]);
    if (ds) { colDate[c] = ds; dates.push(ds); }
  }
  for (var r = 1; r < vals.length; r++) {
    var key = vals[r][0];
    if (!key) continue;
    titles[key] = vals[r][1];
    hist[key] = {};
    for (var c2 in colDate) {
      var v = vals[r][c2];
      if (v !== '' && v !== null) hist[key][colDate[c2]] = Number(v);
    }
  }
  return { hist: hist, titles: titles, dates: dates };
}

function writeHistSheet_(ss, articles, prev, today) {
  var hist = prev.hist, titles = prev.titles;
  articles.forEach(function (a) {
    if (!hist[a.key]) hist[a.key] = {};
    hist[a.key][today] = a.likeCount || 0;
    titles[a.key] = a.name || '(無題)';
  });
  var ds = {}; ds[today] = true;
  prev.dates.forEach(function (d) { ds[d] = true; });
  var dates = Object.keys(ds).sort();

  var header = ['key', 'title'].concat(dates);
  var rows = [header];
  Object.keys(hist).forEach(function (k) {
    var row = [k, titles[k] || ''];
    dates.forEach(function (d) { row.push(hist[k][d] == null ? '' : hist[k][d]); });
    rows.push(row);
  });

  var sh = ss.getSheetByName(SHEET_HIST) || ss.insertSheet(SHEET_HIST);
  sh.clear();
  // 日付ヘッダ(行1, C列以降)を「文字列」書式で固定＝Sheetsの自動日付化を防ぐ（バグの再発防止）
  if (dates.length > 0) sh.getRange(1, 3, 1, dates.length).setNumberFormat('@');
  sh.getRange(1, 1, rows.length, header.length).setValues(rows);
  sh.hideSheet();
  return { hist: hist, titles: titles, dates: dates };
}

// ===== 記事シート（表示用・並べ替え対象） =====
function writeArticlesSheet_(ss, articles, dates) {
  var sh = ss.getSheetByName(SHEET_ARTICLES) || ss.insertSheet(SHEET_ARTICLES);
  var existing = sh.getFilter(); if (existing) existing.remove();
  sh.clear();

  var header = ['順位', '♡スキ', '💬コメント', 'タイトル', '推移', '公開日', 'key'];
  var rows = [header];
  var multiDay = dates.length >= 2;

  for (var i = 0; i < articles.length; i++) {
    var a = articles[i];
    var r = i + 2; // 1-based + ヘッダ
    var title = String(a.name || '(無題)').replace(/"/g, '""').replace(/[\r\n]+/g, ' ');
    // SPARKLINE は key(G列)で _記事別履歴 を MATCH → INDEX で行を引く＝並べ替えに強い
    var spark = multiDay
      ? '=IFERROR(SPARKLINE(INDEX(' + SHEET_HIST + "!$C$2:$ZZ,MATCH($G" + r + ',' + SHEET_HIST + '!$A$2:$A,0),0)),"—")'
      : '—';
    rows.push([
      i + 1,
      a.likeCount || 0,
      a.commentCount || 0,
      '=HYPERLINK("' + a.noteUrl + '","' + title + '")',
      spark,
      String(a.publishAt || '').slice(0, 10),
      a.key
    ]);
  }

  sh.getRange(1, 1, rows.length, header.length).setValues(rows);
  sh.getRange(1, 1, 1, header.length).setFontWeight('bold');
  sh.setFrozenRows(1);
  sh.getRange(2, 2, rows.length - 1, 1).setFontColor(LIKE_COLOR); // ♡列を強調
  sh.setColumnWidth(4, 380); // タイトル
  sh.setColumnWidth(5, 120); // 推移
  sh.hideColumns(7);         // key
  // 見出しの▾で並べ替えできるフィルタ（key列まで含める＝行ごと移動でSPARKLINEが崩れない）
  sh.getRange(1, 1, rows.length, header.length).createFilter();
}

// ===== 記事推移（記事を選んで日時推移を見るインタラクティブシート） =====
// B1 のプルダウンで記事を選ぶ → その記事のスキ数推移が折れ線チャートにライブで切り替わる。
// （Node 版ダッシュボードの「行クリックで展開」のスプレッドシート版）
function writeArticleTrendSheet_(ss, articles, dates) {
  var sh = ss.getSheetByName(SHEET_TREND) || ss.insertSheet(SHEET_TREND);
  var prevSel = sh.getRange('B1').getValue(); // 既存の選択を保持
  sh.getRange('A1:B' + (dates.length + 4)).clearContent();

  var titles = articles.map(function (a) { return a.name || '(無題)'; });

  sh.getRange('A1').setValue('記事を選択 →').setFontWeight('bold');
  sh.getRange('A2').setValue('日付').setFontWeight('bold');
  sh.getRange('B2').setValue('スキ数').setFontWeight('bold');

  // 日付軸(A3..) と、選択記事(=B1)の値を _記事別履歴 から引く式(B3..)
  var grid = [];
  for (var i = 0; i < dates.length; i++) {
    var rr = i + 3;
    grid.push([
      dates[i],
      '=IFERROR(INDEX(' + SHEET_HIST + '!$C$2:$ZZ,MATCH($B$1,' + SHEET_HIST + '!$B$2:$B,0),' +
        'MATCH($A' + rr + ',' + SHEET_HIST + '!$C$1:$ZZ$1,0)),"")'
    ]);
  }
  if (grid.length > 0) {
    sh.getRange(3, 1, grid.length, 1).setNumberFormat('@'); // A列の日付を文字列固定（MATCH整合のため）
    sh.getRange(3, 1, grid.length, 2).setValues(grid);
  }

  // プルダウン（記事タイトル一覧）。前回選択が生きてれば維持、無ければ先頭(=スキ最多)
  var rule = SpreadsheetApp.newDataValidation().requireValueInList(titles, true).setAllowInvalid(true).build();
  sh.getRange('B1').setDataValidation(rule);
  var sel = titles.indexOf(prevSel) >= 0 ? prevSel : (titles[0] || '');
  sh.getRange('B1').setValue(sel).setFontColor(LIKE_COLOR).setFontWeight('bold');

  sh.setColumnWidth(1, 110);
  sh.setColumnWidth(2, 340);
  sh.setFrozenRows(2);
  buildTrendChart_(sh, dates.length + 2);
}

function buildTrendChart_(sh, lastRow) {
  sh.getCharts().forEach(function (c) { sh.removeChart(c); });
  if (lastRow < 3) return; // データ0行なら描かない
  var chart = sh.newChart().asLineChart()
    .addRange(sh.getRange(2, 1, lastRow - 1, 2)) // A2:B(lastRow) = 見出し + データ
    .setPosition(2, 4, 0, 0)
    .setOption('title', '選択した記事のスキ数推移')
    .setOption('legend', { position: 'none' })
    .setOption('colors', [LIKE_COLOR])
    .setOption('pointSize', 3)
    .build();
  sh.insertChart(chart);
}

// ===== 日次履歴（総数の時系列＋折れ線チャート） =====
function writeHistorySheet_(ss, creator, articles, today) {
  var sh = ss.getSheetByName(SHEET_HISTORY) || ss.insertSheet(SHEET_HISTORY);
  if (sh.getLastRow() === 0) sh.appendRow(['日付', '総スキ', '総コメント', '記事数', 'フォロワー']);
  var row = [
    today,
    sumBy_(articles, function (a) { return a.likeCount; }),
    sumBy_(articles, function (a) { return a.commentCount; }),
    articles.length,
    creator.followerCount || 0
  ];
  var lr = sh.getLastRow();
  var dates = lr > 1 ? sh.getRange(2, 1, lr - 1, 1).getDisplayValues().map(function (x) { return x[0]; }) : [];
  var idx = dates.indexOf(today);
  if (idx >= 0) sh.getRange(idx + 2, 1, 1, row.length).setValues([row]);
  else sh.appendRow(row);
  sh.getRange(1, 1, 1, 5).setFontWeight('bold');
  sh.setFrozenRows(1);
  updateTrendChart_(sh);
}

function updateTrendChart_(sh) {
  if (sh.getLastRow() < 3) return; // 2日分以上で描画
  sh.getCharts().forEach(function (c) { sh.removeChart(c); });
  var chart = sh.newChart().asLineChart()
    .addRange(sh.getRange(1, 1, sh.getLastRow(), 2)) // 日付 + 総スキ
    .setPosition(2, 7, 0, 0)
    .setOption('title', '総スキの推移')
    .setOption('legend', { position: 'none' })
    .setOption('colors', [LIKE_COLOR])
    .build();
  sh.insertChart(chart);
}

// ===== サマリ（総数＋前日比） =====
function writeSummarySheet_(ss, creator, articles, today) {
  var sh = ss.getSheetByName(SHEET_SUMMARY) || ss.insertSheet(SHEET_SUMMARY, 0);
  sh.clear();
  var totalLikes = sumBy_(articles, function (a) { return a.likeCount; });
  var totalComments = sumBy_(articles, function (a) { return a.commentCount; });
  var prev = prevHistoryRow_(ss, today);
  var d = function (now, p) { return p == null ? '' : (now - p >= 0 ? '+' : '') + (now - p); };
  var rows = [
    [(creator.nickname || '') + ' (@' + (creator.urlname || '') + ')', '', ''],
    ['総スキ', totalLikes, prev ? d(totalLikes, prev.totalLikes) + ' (前日比)' : ''],
    ['総コメント', totalComments, prev ? d(totalComments, prev.totalComments) + ' (前日比)' : ''],
    ['記事数', articles.length, prev ? d(articles.length, prev.articleCount) + ' (前日比)' : ''],
    ['フォロワー', creator.followerCount || 0, prev ? d(creator.followerCount || 0, prev.followerCount) + ' (前日比)' : ''],
    ['最終更新', Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd HH:mm'), '']
  ];
  sh.getRange(1, 1, rows.length, 3).setValues(rows);
  sh.getRange(1, 1).setFontWeight('bold').setFontSize(14);
  sh.getRange(2, 1, 4, 1).setFontWeight('bold');
  sh.getRange(2, 2).setFontColor(LIKE_COLOR).setFontSize(14).setFontWeight('bold');
  sh.getRange(2, 3, 5, 1).setFontColor('#888888');
  sh.setColumnWidth(1, 150); sh.setColumnWidth(2, 140); sh.setColumnWidth(3, 140);
}

function prevHistoryRow_(ss, today) {
  var sh = ss.getSheetByName(SHEET_HISTORY);
  if (!sh || sh.getLastRow() < 2) return null;
  var vals = sh.getRange(2, 1, sh.getLastRow() - 1, 5).getValues();
  var prev = null;
  vals.forEach(function (r) {
    var dt = r[0] instanceof Date ? Utilities.formatDate(r[0], 'Asia/Tokyo', 'yyyy-MM-dd') : String(r[0]);
    if (dt < today && (!prev || dt > prev._d)) {
      prev = { _d: dt, totalLikes: r[1], totalComments: r[2], articleCount: r[3], followerCount: r[4] };
    }
  });
  return prev;
}

// ===== Slack（任意） =====
function postSlack_(creator, articles) {
  var hook = prop_('SLACK_WEBHOOK_URL');
  if (!hook) return;
  var totalLikes = sumBy_(articles, function (a) { return a.likeCount; });
  var top = articles.slice(0, 5).map(function (a, i) {
    return (i + 1) + '. <' + a.noteUrl + '|' + (a.name || '(無題)') + '> — *' + (a.likeCount || 0) + '*';
  }).join('\n');
  var payload = {
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: '📊 note スキ集計 — ' + (creator.nickname || ''), emoji: true } },
      { type: 'section', text: { type: 'mrkdwn', text: '*♡ 総スキ ' + totalLikes + '*　📝 ' + articles.length + '本' } },
      { type: 'section', text: { type: 'mrkdwn', text: '*スキ上位5本*\n' + top } }
    ]
  };
  UrlFetchApp.fetch(hook, {
    method: 'post', contentType: 'application/json',
    payload: JSON.stringify(payload), muteHttpExceptions: true
  });
}

// ===== トリガー =====
function setupTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'dailySnapshot') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('dailySnapshot').timeBased().everyDays(1).atHour(6).create();
  SpreadsheetApp.getActiveSpreadsheet().toast('毎日6時(JST)に自動実行を設定しました', 'note-suki', 5);
}
