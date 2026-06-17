require('dotenv').config();
const { exec } = require('child_process');
const util = require('util');
const OpenAI = require('openai');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { Telegraf, Markup } = require('telegraf');

// Inisialisasi Otak
const groq = new OpenAI({ baseURL: 'https://api.groq.com/openai/v1', apiKey: process.env.GROQ_API_KEY });
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const bai = new OpenAI({ baseURL: process.env.BAI_BASE_URL || 'https://api.b.ai/v1', apiKey: process.env.BAI_API_KEY || 'missing_api_key' });

let activeAgent = process.env.AI_AGENT || 'groq'; 
let activeBaiModel = process.env.BAI_MODEL || 'claude-3-5-sonnet'; 

const bot = new Telegraf(process.env.TELEGRAM_TOKEN);

function runGMGN(command) {
    return new Promise((resolve, reject) => {
        exec(`npx ${command}`, { env: process.env, maxBuffer: 1024 * 1024 * 10 }, (error, stdout) => {
            if (error) return reject(error);
            resolve(stdout);
        });
    });
}

const delay = ms => new Promise(res => setTimeout(res, ms));

function calculateTotalFees(token) {
    const prio = parseFloat(token.priority_fee || 0);
    const tip = parseFloat(token.tip || token.jito_tip || token.tip_fee || 0);
    const trading = parseFloat(token.trading_fee || token.dex_fee || 0);
    const gas = parseFloat(token.gas_fee || 0);
    const explicitSum = prio + tip + trading + gas;
    const total = parseFloat(token.total_fee || 0);
    const finalFee = total > explicitSum ? total : (explicitSum > 0 ? explicitSum : total);
    return finalFee > 0 ? finalFee.toFixed(4) : '0';
}

function stripAnsi(text) {
    return text.replace(/\x1b\[[0-9;]*m/g, '');
}

async function askAI(rawData, customPrompt, retries = 3) {
    if (activeAgent === 'gemini') {
        const model = genAI.getGenerativeModel({ model: "gemini-3.5-flash" }); 
        for (let i = 0; i < retries; i++) {
            try { return (await model.generateContent(`${customPrompt}\n\nBerikut data mentah JSON-nya:\n${rawData}`)).response.text(); } 
            catch (e) { await delay((i + 1) * 2000); }
        }
        return `❌ Gemini nyerah bro.`;
    } else if (activeAgent === 'bai') {
        for (let i = 0; i < retries; i++) {
            try { return (await bai.chat.completions.create({ model: activeBaiModel, messages: [{ role: "system", content: customPrompt }, { role: "user", content: `Data:\n${rawData}` }] })).choices[0].message.content; } 
            catch (e) { await delay((i + 1) * 2000); }
        }
        return `❌ B.AI nyerah bro.`;
    } else { 
        for (let i = 0; i < retries; i++) {
            try { return (await groq.chat.completions.create({ model: process.env.GROQ_MODEL || "llama-3.3-70b-versatile", messages: [{ role: "system", content: customPrompt }, { role: "user", content: `Data:\n${rawData}` }] })).choices[0].message.content; } 
            catch (e) { await delay((i + 1) * 2000); }
        }
        return `❌ Groq nyerah bro.`;
    }
}

function formatData(rawJson) {
    try {
        const obj = JSON.parse(rawJson);
        if (obj.data && obj.data.rank) {
            let result = '';
            obj.data.rank.forEach((token, i) => {
                const mc = (token.market_cap).toLocaleString('en-US');
                const change = token.price_change_percent1h || 0;
                const sign = change >= 0 ? '+' : '';
                result += `[${i + 1}] ${token.name} ($${token.symbol})\n📍 CA : ${token.address}\n💰 MC : $${mc}\n🎯 Sniper : ${token.sniper_count || 0}\n💸 Fees : ${calculateTotalFees(token)}\n📊 1h : ${sign}${change.toFixed(2)}%\n------------------------\n`;
            });
            return result;
        } else { return JSON.stringify(obj, null, 2).substring(0, 500) + "..."; }
    } catch (e) { return rawJson.substring(0, 500); }
}

function formatAIText(text) {
    return text.replace(/\*\*/g, '*'); // Convert Markdown bold agar support di Telegram (dari ** jadi *)
}

async function sendLongMessage(ctx, text) {
    const maxLength = 4000;
    if (text.length <= maxLength) {
        return await ctx.reply(text, { parse_mode: 'Markdown' });
    }
    const parts = text.split('\n');
    let currentMsg = '';
    for (const part of parts) {
        if (currentMsg.length + part.length + 1 > maxLength) {
            await ctx.reply(currentMsg, { parse_mode: 'Markdown' });
            currentMsg = part + '\n';
        } else {
            currentMsg += part + '\n';
        }
    }
    if (currentMsg.trim() !== '') {
        await ctx.reply(currentMsg, { parse_mode: 'Markdown' });
    }
}

// ==========================================
// 🚀 COMMANDS LOGIC
// ==========================================

async function handleScreenCA(ctx, targetToken) {
    await ctx.reply(`🕵️‍♂️ Narik data CA: ${targetToken}...`);
    try {
        const infoOutput = await runGMGN(`gmgn-cli token info --chain sol --address ${targetToken}`);
        await ctx.reply(`📊 KONTRAK:\n\`\`\`\n${stripAnsi(formatData(infoOutput))}\n\`\`\``, { parse_mode: 'Markdown' });
        
        await ctx.reply(`🤖 Sabar, AI (${activeAgent.toUpperCase()}) lagi ngebedah resiko...`);
        const securityOutput = await runGMGN(`gmgn-cli token security --chain sol --address ${targetToken}`);
        
        let feeTambahan = "Tidak tersedia (Token tidak masuk radar trending/trenches)";
        try {
            const [trend1h, trend24h, trenches] = await Promise.all([
                runGMGN(`gmgn-cli market trending --chain sol --interval 1h --limit 100 --raw`).catch(() => '{}'),
                runGMGN(`gmgn-cli market trending --chain sol --interval 24h --limit 100 --raw`).catch(() => '{}'),
                runGMGN(`gmgn-cli market trenches --chain sol --limit 80 --raw`).catch(() => '{}')
            ]);
            
            const extractTokens = (raw) => {
                try {
                    const obj = JSON.parse(raw);
                    if (obj.data && obj.data.rank) return obj.data.rank;
                    if (obj.data && (obj.data.new_creation || obj.data.pump || obj.data.completed)) {
                        return [ ...(obj.data.new_creation || []), ...(obj.data.pump || []), ...(obj.data.completed || []) ];
                    }
                } catch(e) {}
                return [];
            };

            const allTokens = [...extractTokens(trend1h), ...extractTokens(trend24h), ...extractTokens(trenches)];
            const found = allTokens.find(t => t.address === targetToken);
            
            if (found) {
                feeTambahan = `${calculateTotalFees(found)} SOL`;
            } else {
                try {
                    const infoObj = JSON.parse(infoOutput);
                    if (infoObj.data) {
                        const fee = calculateTotalFees(infoObj.data);
                        if (fee !== '0' && fee !== '0.0000') feeTambahan = `${fee} SOL`;
                    }
                } catch(e) {}
            }
        } catch (e) {}

        const rawData = `[DATA INFO]\n${infoOutput}\n\n[DATA SECURITY]\n${securityOutput}\n\n[DATA TRENDING FEE]\nTotal Fees: ${feeTambahan}`;
        
        const systemPrompt = `Lu adalah crypto degen risk analyst. Tugas lu mengevaluasi data info dan security token Solana ini berdasarkan kriteria risiko standar GMGN.
        Kriteria:
        - rug_ratio: < 0.1 (Pass), 0.1-0.3 (Watch), > 0.3 (Skip)
        - is_wash_trading: true langsung SKIP.
        - top_10_holder_rate: < 0.2 (Pass), 0.2-0.5 (Watch), > 0.5 (Skip)
        - smart_wallets: >= 3 (Pass), 1-2 (Watch), 0 (Skip)

        PENTING: Untuk nilai CA (Contract Address), HANYA ambil persis dari atribut 'address', JANGAN karang angka acak.

        Tampilkan laporan evaluasi risiko secara ringkas:
        **[Symbol] - [Harga]**
           📍 CA: ${targetToken}
           💰 MC / Vol: $(Hitung market cap: price * circulating_supply) / $(Tampilkan volume 24h)
           🧠 Smart Wallets & KOL: (Tampilkan jumlah smart_wallets / renowned_wallets)
           🎯 Sniper: (Tampilkan sniper_count)
           💸 Total Fees: (Ambil info persis dari bagian [DATA TRENDING FEE])
           ⚠️ Rug Ratio: (Tampilkan rug_ratio)
           🛡️ Status Keseluruhan: 🟢 Pass / 🟡 Watch / 🔴 Skip (Berdasarkan dominasi kriteria)
           🚩 Sinyal Merah: (Sebutkan risiko utamanya, misal rug ratio tinggi/holder mendominasi/wash trading)
           💡 Sinyal Hijau: (Sebutkan jika ada metrik yang bagus, misal distribusi holder sehat)
           
        Di baris paling bawah, berikan kesimpulan singkat dan gaya bahasa anak crypto (degen) apakah token ini aman untuk di-ape atau mending di-skip.`;
        
        const aiAnalysis = await askAI(rawData, systemPrompt);
        await sendLongMessage(ctx, `🕵️‍♂️ ANALISA CA SPESIFIK (${activeAgent.toUpperCase()}):\n${stripAnsi(formatAIText(aiAnalysis))}`);
    } catch (error) { await ctx.reply(`❌ Error: ${error.message}`); }
}

async function handleAutoHunt(ctx) {
    await ctx.reply(`🦅 Narik top 3 token trending (1 Jam Terakhir)...`);
    try {
        const output = await runGMGN(`gmgn-cli market trending --chain sol --interval 1h --limit 3`);
        await sendLongMessage(ctx, `🎯 TRENDING TOKEN:\n\`\`\`\n${stripAnsi(formatData(output))}\n\`\`\``);
    } catch (error) { await ctx.reply(`❌ Error: ${error.message}`); }
}

async function handleMeta(ctx) {
    await ctx.reply(`🌊 Narik 20 Token Trending... Sabar, AI lagi mikir narasinya...`);
    try {
        let rawOutput = await runGMGN(`gmgn-cli market trending --chain sol --interval 6h --limit 20 --raw`);
        try {
            let jsonObj = JSON.parse(rawOutput);
            if (jsonObj.data && jsonObj.data.rank) jsonObj.data.rank.forEach(t => t.calculated_total_fees = calculateTotalFees(t) + ' SOL');
            rawOutput = JSON.stringify(jsonObj);
        } catch (e) {}
        
        const systemPrompt = `Lu adalah crypto degen analyst kelas kakap. Tugas lu menganalisa data JSON berisi 20 koin trending di Solana ini.
        Cari benang merah dari nama (name) dan ticker (symbol) koin-koin tersebut.
        PENTING: Untuk nilai CA (Contract Address), HANYA ambil persis dari atribut 'address', JANGAN karang angka acak.
        
        Tampilkan laporan singkat dan padat dengan format:
        **🔥 META SAAT INI:** (Sebutkan narasi yang paling dominan, misal: AI, Kucing, Olahraga, dll)
        **🔑 KEYWORDS:** (Sebutkan kata-kata yang sering muncul)
        **👑 TOP 3 KOIN REPRESENTATIF:** (Sebutkan 3 koin yang mewakili meta ini beserta % kenaikannya)
        **🎯 RATA-RATA SNIPER & FEES:** (Sebutkan insight dari data sniper_count dan rangkum dari nilai "calculated_total_fees" secara keseluruhan)
        **💡 KESIMPULAN:** (Analisa lu apakah meta ini masih fresh atau udah mau basi)`;
        
        const aiAnalysis = await askAI(rawOutput, systemPrompt);
        await sendLongMessage(ctx, `🧠 ANALISA META (${activeAgent.toUpperCase()}):\n${stripAnsi(formatAIText(aiAnalysis))}`);
    } catch (error) { await ctx.reply(`❌ Error: ${error.message}`); }
}

async function handleSlowmoon(ctx) {
    await ctx.reply(`🐢 Mengaktifkan radar Slowmoon (Cek 10 Token 24 Jam Terakhir)...`);
    try {
        const output = await runGMGN(`gmgn-cli market trending --chain sol --interval 24h --limit 10`);
        await sendLongMessage(ctx, `🐢 RADAR SLOWMOON:\n\`\`\`\n${stripAnsi(formatData(output))}\n\`\`\``);
    } catch (error) { await ctx.reply(`❌ Error: ${error.message}`); }
}

async function handleRisk(ctx, isPumpfun = false) {
    await ctx.reply(`☠️ Narik top 10 token trending ${isPumpfun ? '(Pump.fun)' : ''} buat risk screening...`);
    try {
        let rawOutput = await runGMGN(`gmgn-cli market trending --chain sol --interval 1h --limit ${isPumpfun ? '100' : '10'} --raw`);
        try {
            let jsonObj = JSON.parse(rawOutput);
            if (jsonObj.data && jsonObj.data.rank) {
                let tokens = jsonObj.data.rank;
                if (isPumpfun) tokens = tokens.filter(t => t.address && t.address.endsWith('pump')).slice(0, 10);
                tokens.forEach(t => t.calculated_total_fees = calculateTotalFees(t) + ' SOL');
                jsonObj.data.rank = tokens;
            }
            rawOutput = JSON.stringify(jsonObj);
        } catch(e) {}

        const systemPrompt = isPumpfun ? `Lu adalah crypto degen risk analyst. Tugas lu mengevaluasi data JSON dari 10 token trending di Solana (Khusus Pump.fun) ini berdasarkan kriteria risiko standar GMGN. AI juga harus mengevaluasi potensi Bundler dan Konsentrasi Holder.
        Kriteria:
        - rug_ratio: < 0.1 (Pass), 0.1-0.3 (Watch), > 0.3 (Skip)
        - is_wash_trading: true langsung SKIP.
        - top_10_holder_rate: < 20% (Aman), 20%-30% (Waspada), > 30% (Bahaya Bundler/Cabut!)
        - smart_degen_count: >= 3 (Pass), 1-2 (Watch), 0 (Skip)
        - creator_token_status: creator_close (Pass), creator_hold (Skip/Watch)
        - liquidity: > $50k (Pass), $10k-$50k (Watch), < $10k (Skip)

        PENTING: Untuk nilai CA (Contract Address), HANYA ambil persis dari atribut 'address', JANGAN karang angka acak.

        Tampilkan laporan evaluasi risiko untuk masing-masing token secara ringkas:
        **[Nomor]. [Symbol] - [Harga]**
           📍 CA: (Tampilkan address token)
           💰 MC / Vol: $(Tampilkan market_cap) / $(Tampilkan volume)
           🧠 Smart Wallets: (Tampilkan smart_degen_count)
           🎯 Sniper: (Tampilkan sniper_count)
           💸 Total Fees: (Tampilkan persis nilai dari atribut "calculated_total_fees")
           📦 Risiko Bundler: (Sebutkan tingkat bahayanya berdasarkan top_10_holder_rate, gunakan emoji 🚨 jika > 30%)
           🛡️ Status Keseluruhan: 🟢 Pass / 🟡 Watch / 🔴 Skip (Berdasarkan dominasi kriteria)
           🚩 Sinyal Merah: (Sebutkan risiko utamanya, misal rug ratio tinggi/holder mendominasi)
           💡 Sinyal Hijau: (Sebutkan jika ada metrik yang bagus)
           
        Di baris paling bawah, berikan kesimpulan 1-2 token yang paling "aman" untuk di-ape (kalau tidak ada bilang hindari semua).` : `Lu adalah crypto degen risk analyst. Tugas lu mengevaluasi data JSON dari 10 token trending di Solana ini berdasarkan kriteria risiko standar GMGN.
        Kriteria:
        - rug_ratio: < 0.1 (Pass), 0.1-0.3 (Watch), > 0.3 (Skip)
        - is_wash_trading: true langsung SKIP.
        - top_10_holder_rate: < 0.2 (Pass), 0.2-0.5 (Watch), > 0.5 (Skip)
        - smart_degen_count: >= 3 (Pass), 1-2 (Watch), 0 (Skip)
        - creator_token_status: creator_close (Pass), creator_hold (Skip/Watch)
        - liquidity: > $50k (Pass), $10k-$50k (Watch), < $10k (Skip)

        PENTING: Untuk nilai CA (Contract Address), HANYA ambil persis dari atribut 'address', JANGAN karang angka acak.

        Tampilkan laporan evaluasi risiko untuk masing-masing token secara ringkas:
        **[Nomor]. [Symbol] - [Harga]**
           📍 CA: (Tampilkan address token)
           💰 MC / Vol: $(Tampilkan market_cap) / $(Tampilkan volume)
           🧠 Smart Wallets: (Tampilkan smart_degen_count)
           🎯 Sniper: (Tampilkan sniper_count)
           💸 Total Fees: (Tampilkan persis nilai dari atribut "calculated_total_fees")
           🛡️ Status Keseluruhan: 🟢 Pass / 🟡 Watch / 🔴 Skip (Berdasarkan dominasi kriteria)
           🚩 Sinyal Merah: (Sebutkan risiko utamanya, misal rug ratio tinggi/holder mendominasi)
           💡 Sinyal Hijau: (Sebutkan jika ada metrik yang bagus)
           
        Di baris paling bawah, berikan kesimpulan 1-2 token yang paling "aman" untuk di-ape (kalau tidak ada bilang hindari semua).`;

        const aiAnalysis = await askAI(rawOutput, systemPrompt);
        await sendLongMessage(ctx, `☠️ DEGEN RISK SCREENING ${isPumpfun ? '(PUMP.FUN) ' : ''}(${activeAgent.toUpperCase()}):\n${stripAnsi(formatAIText(aiAnalysis))}`);
    } catch (error) { await ctx.reply(`❌ Error: ${error.message}`); }
}

async function handleFees(ctx, interval) {
    await ctx.reply(`💸 Narik data fee paling gila (${interval})...`);
    try {
        let rawOutput = await runGMGN(`gmgn-cli market trending --chain sol --interval ${interval} --limit 50 --raw`);
        try {
            let jsonObj = JSON.parse(rawOutput);
            if (jsonObj.data && jsonObj.data.rank) {
                jsonObj.data.rank.sort((a, b) => parseFloat(calculateTotalFees(b)) - parseFloat(calculateTotalFees(a)));
                jsonObj.data.rank = jsonObj.data.rank.slice(0, 10);
                jsonObj.data.rank.forEach(t => t.calculated_total_fees = calculateTotalFees(t) + ' SOL');
            }
            rawOutput = JSON.stringify(jsonObj);
        } catch(e) {}
        
        const systemPrompt = `Lu adalah crypto degen analyst. Tugas lu mengevaluasi 10 token dengan TOTAL FEES TERBESAR di Solana (interval ${interval}) berdasarkan data JSON ini.
        PENTING: Untuk nilai CA (Contract Address), HANYA ambil persis dari atribut 'address', JANGAN karang angka acak.
        
        Tampilkan laporan evaluasi risiko secara ringkas:
        **[Nomor]. [Symbol] - [Harga]**
           📍 CA: (Tampilkan address token)
           💰 MC / Vol: $(Tampilkan market_cap) / $(Tampilkan volume)
           💸 Total Fees: (Tampilkan persis nilai dari atribut "calculated_total_fees")
           🎯 Sniper & Smart Wallets: (Tampilkan sniper_count / smart_degen_count)
           🛡️ Status Keseluruhan: 🟢 Pass / 🟡 Watch / 🔴 Skip
           💡 Insight: (Analisa 1 kalimat kenapa token ini fees-nya gede, misal banyak bot/sniper atau emang volume organik)
           
        Di baris paling bawah, berikan kesimpulan 1-2 token yang pergerakannya paling organik dan "aman".`;
        
        const aiAnalysis = await askAI(rawOutput, systemPrompt);
        await sendLongMessage(ctx, `💸 TOP FEES (${interval.toUpperCase()}) - ${activeAgent.toUpperCase()}:\n${stripAnsi(formatAIText(aiAnalysis))}`);
    } catch (error) { await ctx.reply(`❌ Error: ${error.message}`); }
}

async function handleMicroMomentum(ctx, interval) {
    await ctx.reply(`⚡ Narik data token trending (${interval}) buat cari anomali momentum & lonjakan volume...`);
    try {
        let rawOutput = await runGMGN(`gmgn-cli market trending --chain sol --interval ${interval} --limit 15 --raw`);

        const systemPrompt = `Lu adalah Crypto Scalper/Sniper handal. Tugas lu mencari koin yang volume dan harganya mau meledak di timeframe super pendek (${interval}) berdasarkan data JSON ini.
        Fokus cari anomali lonjakan volume mendadak atau buy pressure yang tinggi.
        PENTING: Untuk nilai CA (Contract Address), HANYA ambil persis dari atribut 'address', JANGAN karang angka acak.
        
        Tampilkan laporan evaluasi momentum secara ringkas:
        **[Nomor]. [Symbol] - [Harga]**
           📍 CA: (Tampilkan address token)
           💰 MC: $(Tampilkan market_cap)
           🚀 Lonjakan ${interval}: (Tampilkan price_change_percent dengan tanda % dan + jika positif)
           💡 Indikasi Sinyal: (Analisa lu apakah buy pressure ini organik atau murni bot wash trading)
           
        Di baris paling bawah, berikan kesimpulan 1-2 token yang momentumnya paling gila dan layak di-snipe sekarang.`;

        const aiAnalysis = await askAI(rawOutput, systemPrompt);
        await sendLongMessage(ctx, `⚡ MICRO MOMENTUM SCANNER (${interval.toUpperCase()}) - ${activeAgent.toUpperCase()}:\n${stripAnsi(formatAIText(aiAnalysis))}`);
    } catch (error) { await ctx.reply(`❌ Error: ${error.message}`); }
}

async function handleCreator(ctx, creatorAddress) {
    await ctx.reply(`🕵️‍♂️ Narik data performa wallet dev: ${creatorAddress}...`);
    try {
        let rawOutput = await runGMGN(`gmgn-cli wallet info --chain sol --address ${creatorAddress}`);

        const systemPrompt = `Lu adalah crypto investigator spesialis on-chain. Tugas lu membedah data mentah dari dompet dev ini untuk mencari tanda-tanda 'Serial Rugger'.
        Cari tanda-tanda seperti: win rate sangat rendah, token sering dicabut liquidity-nya, atau total PnL minus parah.
        PENTING: Untuk nilai Wallet Dev / CA (Contract Address), HANYA ambil persis dari atribut 'address' atau input yang diberikan, JANGAN karang angka acak.
        
        Tampilkan laporan investigasi secara ringkas:
        **👤 Wallet Dev: ${creatorAddress}**
        📊 Win Rate / PnL: (Tampilkan win rate dalam % / total PnL)
        ☠️ Prediksi Sifat Dev: (Berdasarkan datanya, apakah dia tipe dev yang amanah, jeeter, atau murni serial rugger)
        
        Di baris paling bawah, berikan kesimpulan apakah token dari dev ini layak dibeli atau harus di-blacklist.`;

        const aiAnalysis = await askAI(rawOutput, systemPrompt);
        await sendLongMessage(ctx, `🕵️‍♂️ CREATOR WALLET SCANNER - ${activeAgent.toUpperCase()}:\n${stripAnsi(formatAIText(aiAnalysis))}`);
    } catch (error) { await ctx.reply(`❌ Error: ${error.message}`); }
}

// ==========================================
// 🤖 TELEGRAM ROUTES
// ==========================================

const mainMenu = Markup.inlineKeyboard([
    [Markup.button.callback('🌊 Meta Scanner', 'meta_scanner'), Markup.button.callback('☠️ Top 10 Risk', 'risk_scanner')],
    [Markup.button.callback('💊 Pump.fun Risk', 'pump_scanner'), Markup.button.callback('🐢 Slowmoon Radar', 'slowmoon')],
    [Markup.button.callback('💸 Top Fees 1h', 'fees_1h'), Markup.button.callback('💸 Top Fees 24h', 'fees_24h')],
    [Markup.button.callback('⚡ Momentum 5m', 'momentum_5m'), Markup.button.callback('⚡ Momentum 15m', 'momentum_15m')],
    [Markup.button.callback('🦅 Auto-Hunting', 'auto_hunt'), Markup.button.callback('🕵️‍♂️ Creator Scanner', 'creator_scanner')],
    [Markup.button.callback('🔎 Screening 1 CA', 'screen_ca'), Markup.button.callback('🧠 Ganti Otak AI', 'change_agent')]
]);

const agentMenu = Markup.inlineKeyboard([
    [
        Markup.button.callback('Groq', 'set_groq'),
        Markup.button.callback('Gemini', 'set_gemini')
    ],
    [
        Markup.button.callback('B.AI', 'set_bai')
    ],
    [Markup.button.callback('⬅️ Kembali', 'main_menu')]
]);

const showMainMenu = (ctx) => {
    let agentStatus = activeAgent.toUpperCase();
    if (activeAgent === 'bai') agentStatus += ` (${activeBaiModel})`;

    const text = `🤖 *BOTS DEGEN GMGN* 🤖\n\nOtak Aktif: *${agentStatus}*\n\nPilih mode tempur lu dari menu di bawah ini atau ketik /ca <address> untuk analisa spesifik.`;

    if (ctx.callbackQuery) {
        ctx.editMessageText(text, { ...mainMenu, parse_mode: 'Markdown' }).catch(e => console.log(e)); // Avoid crash on same message
    } else {
        ctx.reply(text, { ...mainMenu, parse_mode: 'Markdown' });
    }
};

bot.start(showMainMenu);
bot.command('menu', showMainMenu);

bot.command('ca', (ctx) => {
    const ca = ctx.message.text.split(' ')[1];
    if (!ca) return ctx.reply('❌ Masukin CA-nya brok! Contoh: /ca 9MTge3du...');
    handleScreenCA(ctx, ca);
});

bot.command('dev', (ctx) => {
    const dev = ctx.message.text.split(' ')[1];
    if (!dev) return ctx.reply('❌ Masukin Address Dev-nya brok! Contoh: /dev A3bC...');
    handleCreator(ctx, dev);
});
 
// Main menu actions
bot.action('meta_scanner', async (ctx) => { await ctx.answerCbQuery('Memproses Meta Scanner...'); handleMeta(ctx); });
bot.action('risk_scanner', async (ctx) => { await ctx.answerCbQuery('Memproses Top 10 Risk...'); handleRisk(ctx, false); });
bot.action('pump_scanner', async (ctx) => { await ctx.answerCbQuery('Memproses Pump.fun Risk...'); handleRisk(ctx, true); });
bot.action('fees_1h', async (ctx) => { await ctx.answerCbQuery('Memproses Top Fees 1h...'); handleFees(ctx, '1h'); });
bot.action('fees_24h', async (ctx) => { await ctx.answerCbQuery('Memproses Top Fees 24h...'); handleFees(ctx, '24h'); });
bot.action('auto_hunt', async (ctx) => { await ctx.answerCbQuery('Memproses Auto-Hunt...'); handleAutoHunt(ctx); });
bot.action('slowmoon', async (ctx) => { await ctx.answerCbQuery('Memproses Slowmoon...'); handleSlowmoon(ctx); });
bot.action('momentum_5m', async (ctx) => { await ctx.answerCbQuery('Memproses Momentum 5m...'); handleMicroMomentum(ctx, '5m'); });
bot.action('momentum_15m', async (ctx) => { await ctx.answerCbQuery('Memproses Momentum 15m...'); handleMicroMomentum(ctx, '15m'); });

bot.action('creator_scanner', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.reply('👇 Silakan kirimkan command: `/dev <address>` di chat ini.', { parse_mode: 'Markdown' });
});

bot.action('screen_ca', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.reply('👇 Silakan kirimkan command: `/ca <address>` di chat ini.', { parse_mode: 'Markdown' });
});

// Agent selection menu
bot.action('change_agent', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.editMessageText('🧠 Pilih otak AI yang mau lu pake:', agentMenu);
});

bot.action(/set_(.+)/, async (ctx) => {
    const newAgent = ctx.match[1];
    
    if (newAgent === 'bai') {
        await ctx.answerCbQuery('⏳ Memuat model B.AI...');
        try {
            const baiUrl = (process.env.BAI_BASE_URL || 'https://api.b.ai/v1').replace(/\/$/, '') + '/models';
            const response = await fetch(baiUrl, { headers: { 'Authorization': `Bearer ${process.env.BAI_API_KEY || 'missing_api_key'}`, 'Content-Type': 'application/json' } });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const data = await response.json();
            const models = data.data || [];
            
            const modelButtons = models.map(m => [Markup.button.callback(m.id, `modelbai_${m.id}`)]);
            modelButtons.push([Markup.button.callback('⬅️ Kembali', 'change_agent')]);
            
            await ctx.editMessageText('🧠 Pilih model B.AI yang mau lu pake:', Markup.inlineKeyboard(modelButtons));
        } catch (err) {
            await ctx.answerCbQuery(`❌ Gagal ambil list model B.AI: ${err.message}`, { show_alert: true });
        }
        return;
    }

    if (['groq', 'gemini'].includes(newAgent)) {
        activeAgent = newAgent;
        await ctx.answerCbQuery(`✅ Otak AI diganti ke: ${newAgent.toUpperCase()}`);
        showMainMenu(ctx);
    } else {
        await ctx.answerCbQuery('❌ Otak AI tidak valid!');
    }
});

bot.action(/modelbai_(.+)/, async (ctx) => {
    const modelId = ctx.match[1];
    activeAgent = 'bai';
    activeBaiModel = modelId;
    await ctx.answerCbQuery(`✅ Otak AI diganti ke: B.AI (${modelId})`);
    showMainMenu(ctx);
});

bot.action('main_menu', async (ctx) => {
    await ctx.answerCbQuery();
    showMainMenu(ctx);
});


bot.telegram.setMyCommands([
    { command: 'start', description: '🚀 Mulai & Tampilkan Menu' },
    { command: 'menu', description: '📋 Tampilkan Menu Utama' },
    { command: 'ca', description: '🕵️‍♂️ Analisa 1 CA (contoh: /ca <address>)' },
    { command: 'dev', description: '🕵️‍♂️ Analisa Wallet Dev (contoh: /dev <address>)' },
]);

bot.launch().then(() => console.log('🤖 Bot Telegram Degen udah jalan...'));
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));