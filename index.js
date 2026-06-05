require('dotenv').config();
const readline = require('readline');
const { exec } = require('child_process');
const util = require('util');
const OpenAI = require('openai');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const fs = require('fs');
const path = require('path');

if (!fs.existsSync(path.join(__dirname, 'logs'))) {
    fs.mkdirSync(path.join(__dirname, 'logs'));
}

// Inisialisasi Otak Groq
const groq = new OpenAI({
    baseURL: 'https://api.groq.com/openai/v1',
    apiKey: process.env.GROQ_API_KEY,
});

// Inisialisasi Otak Gemini
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Inisialisasi Otak Ollama (Custom)
const ollama = new OpenAI({
    baseURL: process.env.OLLAMA_BASE_URL || 'https://ollama.fliw.my.id/v1', // Sesuai konvensi OpenAI-compatible
    apiKey: 'ollama', // API key tidak wajib untuk Ollama, tapi library butuh placeholder
});

// Inisialisasi Otak B.AI
const bai = new OpenAI({
    baseURL: process.env.BAI_BASE_URL || 'https://api.b.ai/v1', 
    apiKey: process.env.BAI_API_KEY || 'missing_api_key',
});

let activeAgent = process.env.AI_AGENT || 'groq'; // Default agent
let activeOllamaModel = 'llama3'; // Default model untuk Ollama
let activeBaiModel = process.env.BAI_MODEL || 'claude-3-5-sonnet'; // Default model untuk B.AI
 
const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

function runGMGN(command) {
    return new Promise((resolve, reject) => {
        // Tambahin maxBuffer 10MB biar ga crash pas narik JSON gede
        exec(`npx ${command}`, { env: process.env, maxBuffer: 1024 * 1024 * 10 }, (error, stdout, stderr) => {
            if (error) {
                reject(error);
                return;
            }
            resolve(stdout);
        });
    });
}

// Helper buat delay/jeda nunggu
const delay = ms => new Promise(res => setTimeout(res, ms));

// ==========================================
// 💾 HELPER: Auto-Save Log ke File
// ==========================================
function saveLogToFile(modeName, content) {
    const date = new Date();
    const dateStr = date.toISOString().split('T')[0]; // Format: YYYY-MM-DD
    const timeStr = date.toTimeString().split(' ')[0]; // Format: HH:MM:SS
    const filePath = path.join(__dirname, 'logs', `${modeName}-${dateStr}.txt`);
    
    const cleanContent = content.replace(/\x1b\[[0-9;]*m/g, ''); // Bersihkan kode ANSI terminal
    const logText = `\n[${timeStr}]\n${cleanContent}\n--------------------------------------------------\n`;
    fs.appendFileSync(filePath, logText, 'utf8');
}

// ==========================================
// 🧮 HELPER: Kalkulasi Total Fees Akurat (Prio + Tip + Trading)
// ==========================================
function calculateTotalFees(token) {
    const prio = parseFloat(token.priority_fee || 0);
    const tip = parseFloat(token.tip || token.jito_tip || token.tip_fee || 0);
    const trading = parseFloat(token.trading_fee || token.dex_fee || 0);
    const gas = parseFloat(token.gas_fee || 0);
    const explicitSum = prio + tip + trading + gas;
    
    const total = parseFloat(token.total_fee || 0);
    // Ambil nilai terbesar untuk menghindari double-count jika total_fee sudah di-merge oleh API
    const finalFee = total > explicitSum ? total : (explicitSum > 0 ? explicitSum : total);
    return finalFee > 0 ? finalFee.toFixed(4) : '0';
}

// ==========================================
//  HELPER: Fungsi Manggil Otak AI (Groq/Gemini)
// ==========================================
async function askAI(rawData, customPrompt, retries = 3) {
    if (activeAgent === 'gemini') {
        // Pake model Gemini yang baru sesuai request lu
        const model = genAI.getGenerativeModel({ model: "gemini-3.5-flash" }); 
        const finalPrompt = `${customPrompt}\n\nBerikut adalah data mentah JSON-nya:\n${rawData}`;
        for (let i = 0; i < retries; i++) {
            try {
                const result = await model.generateContent(finalPrompt);
                return result.response.text();
            } catch (error) {
                if (error.message && error.message.includes('503')) {
                    console.log(`\x1b[33m⏳ Server API Gemini lagi penuh (503). Coba lagi dalam ${(i + 1) * 2} detik... (Percobaan ${i + 1}/${retries})\x1b[0m`);
                    await delay((i + 1) * 2000);
                    continue;
                }
                return `❌ Gagal mikir Gemini: ${error.message}`;
            }
        }
        return `❌ Gemini nyerah bro. Udah di-retry ${retries} kali server tetep penuh. Coba lagi nanti!`;
    } else if (activeAgent === 'ollama') {
        for (let i = 0; i < retries; i++) {
            try {
                const response = await ollama.chat.completions.create({
                    model: activeOllamaModel, // Pakai model Ollama yang dipilih
                    messages: [
                        { role: "system", content: customPrompt },
                        { role: "user", content: `Berikut adalah data mentah JSON-nya:\n${rawData}` }
                    ]
                });
                return response.choices[0].message.content;
            } catch (error) {
                if (error.status === 503 || error.status === 429 || (error.message && error.message.includes('503'))) {
                    console.log(`\x1b[33m⏳ Server API Ollama lagi penuh atau limit. Coba lagi dalam ${(i + 1) * 2} detik... (Percobaan ${i + 1}/${retries})\x1b[0m`);
                    await delay((i + 1) * 2000);
                    continue;
                }
                return `❌ Gagal mikir Ollama (${activeOllamaModel}): ${error.message}`;
            }
        }
        return `❌ Ollama nyerah bro. Udah di-retry ${retries} kali server tetep penuh. Coba lagi nanti!`;
    } else if (activeAgent === 'bai') {
        for (let i = 0; i < retries; i++) {
            try {
                const response = await bai.chat.completions.create({
                    model: process.env.BAI_MODEL || "claude-3-5-sonnet", // Ganti default model jika perlu
                    model: activeBaiModel,
                    messages: [
                        { role: "system", content: customPrompt },
                        { role: "user", content: `Berikut adalah data mentah JSON-nya:\n${rawData}` }
                    ]
                });
                return response.choices[0].message.content;
            } catch (error) {
                if (error.status === 503 || error.status === 429 || (error.message && error.message.includes('503'))) {
                    console.log(`\x1b[33m⏳ Server API B.AI lagi penuh atau limit. Coba lagi dalam ${(i + 1) * 2} detik... (Percobaan ${i + 1}/${retries})\x1b[0m`);
                    await delay((i + 1) * 2000);
                    continue;
                }
                return `❌ Gagal mikir B.AI: ${error.message}`;
            }
        }
        return `❌ B.AI nyerah bro. Udah di-retry ${retries} kali server tetep penuh. Coba lagi nanti!`;
    } else { // Groq
        for (let i = 0; i < retries; i++) {
            try {
                const response = await groq.chat.completions.create({
                    // Setel ke model groq
                    model: process.env.GROQ_MODEL || "llama-3.3-70b-versatile",
                    messages: [
                        { role: "system", content: customPrompt },
                        { role: "user", content: `Berikut adalah data mentah JSON-nya:\n${rawData}` }
                    ]
                });
                return response.choices[0].message.content;
            } catch (error) {
                if (error.status === 503 || error.status === 429 || (error.message && error.message.includes('503'))) {
                    console.log(`\x1b[33m⏳ Server API Groq lagi penuh atau limit. Coba lagi dalam ${(i + 1) * 2} detik... (Percobaan ${i + 1}/${retries})\x1b[0m`);
                    await delay((i + 1) * 2000);
                    continue;
                }
                return `❌ Gagal mikir Groq: ${error.message}`;
            }
        }
        return `❌ Groq nyerah bro. Udah di-retry ${retries} kali server tetep penuh. Coba lagi nanti!`;
    }
}

// ==========================================
// 🎨 HELPER: Formatter Warna Terminal
// ==========================================
function formatData(rawJson) {
    try {
        const obj = JSON.parse(rawJson);
        if (obj.data && obj.data.rank) {
            let result = '';
            obj.data.rank.forEach((token, i) => {
                const mc = (token.market_cap).toLocaleString('en-US');
                const change = token.price_change_percent1h || 0;
                const changeColor = change >= 0 ? '\x1b[32m' : '\x1b[31m'; 
                const sign = change >= 0 ? '+' : '';
                const sniper = token.sniper_count || 0;
                const fee = calculateTotalFees(token);

                result += `\x1b[36m[${i + 1}]\x1b[0m \x1b[33m${token.name}\x1b[0m (\x1b[37m$${token.symbol}\x1b[0m)\n`;
                result += `    📍 CA : \x1b[90m${token.address}\x1b[0m\n`;
                result += `    💰 MC : $${mc}\n`;
                result += `    🎯 Sniper : ${sniper}\n`;
                result += `    💸 Fees : ${fee}\n`;
                result += `    📊 1h : ${changeColor}${sign}${change.toFixed(2)}%\x1b[0m\n`;
                result += `----------------------------------------\n`;
            });
            return result;
        } else {
            return util.inspect(obj, { colors: true, depth: null });
        }
    } catch (e) {
        return rawJson;
    }
}

// ==========================================
// 🎨 HELPER: Formatter Warna Terminal untuk AI
// ==========================================
function formatAIText(text) {
    return text
        // Format teks tebal (Markdown) jadi warna Cyan terang
        .replace(/\*\*(.*?)\*\*/g, '\x1b[1m\x1b[36m$1\x1b[0m')
        // Warna Status
        .replace(/🟢 Pass/g, '\x1b[32m🟢 Pass\x1b[0m')
        .replace(/🔴 Skip/g, '\x1b[31m🔴 Skip\x1b[0m')
        .replace(/🟡 Watch/g, '\x1b[33m🟡 Watch\x1b[0m')
        // Warna Kategori Mode 5 & Highlight Angka / CA
        .replace(/📍 CA:\s*([a-zA-Z0-9]+)/g, '\x1b[90m📍 CA:\x1b[0m \x1b[36m$1\x1b[0m')
        .replace(/💰 MC \/ Vol:\s*(.*)/g, '\x1b[33m💰 MC / Vol:\x1b[0m \x1b[32m$1\x1b[0m')
        .replace(/🧠 Smart Wallets:\s*([0-9]+)/g, '\x1b[35m🧠 Smart Wallets:\x1b[0m \x1b[33m$1\x1b[0m')
        .replace(/🧠 Smart Wallets & KOL:\s*(.*)/gi, '\x1b[35m🧠 Smart Wallets & KOL:\x1b[0m \x1b[33m$1\x1b[0m')
        .replace(/🎯 Sniper:\s*([0-9]+)/gi, '\x1b[35m🎯 Sniper:\x1b[0m \x1b[31m$1\x1b[0m')
        .replace(/💸 Total Fees:\s*(.*)/gi, '\x1b[33m💸 Total Fees:\x1b[0m \x1b[32m$1\x1b[0m')
        .replace(/⚠️ Rug Ratio:\s*([0-9.]+)/g, '\x1b[33m⚠️ Rug Ratio:\x1b[0m \x1b[31m$1\x1b[0m')
        .replace(/🛡️ Status Keseluruhan:/g, '\x1b[34m🛡️ Status Keseluruhan:\x1b[0m')
        .replace(/🚩 Sinyal Merah:/g, '\x1b[31m🚩 Sinyal Merah:\x1b[0m')
        .replace(/💡 Sinyal Hijau:/g, '\x1b[32m💡 Sinyal Hijau:\x1b[0m')
        // Warna Kategori Mode 3
        .replace(/🔥 META SAAT INI:/g, '\x1b[36m🔥 META SAAT INI:\x1b[0m')
        .replace(/🔑 KEYWORDS:/g, '\x1b[33m🔑 KEYWORDS:\x1b[0m')
        .replace(/👑 TOP 3 KOIN REPRESENTATIF:/g, '\x1b[35m👑 TOP 3 KOIN REPRESENTATIF:\x1b[0m')
        .replace(/🎯 RATA-RATA SNIPER & FEES:/g, '\x1b[35m🎯 RATA-RATA SNIPER & FEES:\x1b[0m')
        .replace(/💡 KESIMPULAN:/g, '\x1b[32m💡 KESIMPULAN:\x1b[0m')
        .replace(/ Risiko Bundler:/g, '\x1b[31m📦 Risiko Bundler:\x1b[0m');
}

// ==========================================
// 🕵️‍♂️ MODE 1: Screening CA Spesifik
// ==========================================
async function screenSpecificCA(targetToken) {
    console.log(`\n🕵️‍♂️ Narik data daleman CA: ${targetToken}...`);
    try {
        const infoOutput = await runGMGN(`gmgn-cli token info --chain sol --address ${targetToken}`);
        console.log("\n================ [ 📊 DATA KONTRAK ] ================");
        console.log(formatData(infoOutput));
        
        console.log(`\n🤖 Sabar, AI lagi ngebedah data keamanan & resikonya...`);
        const securityOutput = await runGMGN(`gmgn-cli token security --chain sol --address ${targetToken}`);
        
        // Narik data Total Fee dengan nge-scan endpoint market 1h, 24h, dan trenches biar akurat kayak Mode 5
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
                        return [
                            ...(obj.data.new_creation || []), 
                            ...(obj.data.pump || []), 
                            ...(obj.data.completed || [])
                        ];
                    }
                } catch(e) {}
                return [];
            };

            const allTokens = [...extractTokens(trend1h), ...extractTokens(trend24h), ...extractTokens(trenches)];
            const found = allTokens.find(t => t.address === targetToken);
            
            if (found) {
                feeTambahan = `${calculateTotalFees(found)} SOL`;
            } else {
                // Fallback cek langsung dari data token info
                try {
                    const infoObj = JSON.parse(infoOutput);
                    if (infoObj.data) {
                        const fee = calculateTotalFees(infoObj.data);
                        if (fee !== '0' && fee !== '0.0000') feeTambahan = `${fee} SOL`;
                    }
                } catch(e) {}
            }
        } catch (e) {
            // Abaikan error
        }

        const rawData = `[DATA INFO]\n${infoOutput}\n\n[DATA SECURITY]\n${securityOutput}\n\n[DATA TRENDING FEE]\nTotal Fees: ${feeTambahan}`;
        
        const systemPrompt = `Lu adalah crypto degen risk analyst. Tugas lu mengevaluasi data info dan security token Solana ini berdasarkan kriteria risiko standar GMGN.
        Kriteria:
        - rug_ratio: < 0.1 (Pass), 0.1-0.3 (Watch), > 0.3 (Skip)
        - is_wash_trading: true langsung SKIP.
        - top_10_holder_rate: < 0.2 (Pass), 0.2-0.5 (Watch), > 0.5 (Skip)
        - smart_wallets: >= 3 (Pass), 1-2 (Watch), 0 (Skip)

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

        console.log(`\n================ [ 🕵️‍♂️ ANALISA CA SPESIFIK (${activeAgent.toUpperCase()}) ] ================`);
        console.log(formatAIText(aiAnalysis));
        saveLogToFile('screening', formatAIText(aiAnalysis));
        console.log("==============================================================\n");
    } catch (error) {
        console.error("❌ Error cuy:", error.message);
    }
}

// ==========================================
// 🦅 MODE 2: Auto-Hunting Token
// ==========================================
async function autoHuntTokens() {
    console.log(`\n🦅 Narik top 3 token trending (1 Jam Terakhir)...`);
    try {
        const output = await runGMGN(`gmgn-cli market trending --chain sol --interval 1h --limit 3`);
        console.log("\n================ [ 🎯 TRENDING TOKEN ] ================");
        console.log(formatData(output));
        console.log("=======================================================\n");
    } catch (error) {
        console.error("❌ Error cuy:", error.message);
    }
}

// ==========================================
// 🌊 MODE 3: Meta & Narrative Scanner (AI POWERED)
// ==========================================
async function scanCurrentMeta() {
    console.log(`\n🌊 Narik 20 Token Trending... Sabar, lagi nyuruh Gemini mikir narasinya...`);
    try {
        let rawOutput = await runGMGN(`gmgn-cli market trending --chain sol --interval 6h --limit 20 --raw`);
        try {
            let jsonObj = JSON.parse(rawOutput);
            if (jsonObj.data && jsonObj.data.rank) {
                // Injeksi nilai total fees yang akurat sebelum dikasih ke AI
                jsonObj.data.rank.forEach(t => t.calculated_total_fees = calculateTotalFees(t) + ' SOL');
            }
            rawOutput = JSON.stringify(jsonObj);
        } catch (e) {}

        const systemPrompt = `Lu adalah crypto degen analyst kelas kakap. Tugas lu menganalisa data JSON berisi 20 koin trending di Solana ini.
        Cari benang merah dari nama (name) dan ticker (symbol) koin-koin tersebut.
        
        Tampilkan laporan singkat dan padat dengan format:
        🔥 META SAAT INI: (Sebutkan narasi yang paling dominan, misal: AI, Kucing, Olahraga, dll)
        🔑 KEYWORDS: (Sebutkan kata-kata yang sering muncul)
        👑 TOP 3 KOIN REPRESENTATIF: (Sebutkan 3 koin yang mewakili meta ini beserta % kenaikannya)
        🎯 RATA-RATA SNIPER & FEES: (Sebutkan insight dari data sniper_count dan rangkum dari nilai "calculated_total_fees" secara keseluruhan)
        💡 KESIMPULAN: (Analisa lu apakah meta ini masih fresh atau udah mau basi)`;

        const aiAnalysis = await askAI(rawOutput, systemPrompt);

        console.log(`\n================ [ 🧠 ANALISA META ${activeAgent.toUpperCase()} ] ================`);
        console.log(formatAIText(aiAnalysis));
        saveLogToFile('meta', formatAIText(aiAnalysis));
        console.log("==============================================================\n");
    } catch (error) {
        console.error("❌ Error cuy:", error.message);
    }
}

// ==========================================
// 🐢 MODE 4: Slowmoon Radar
// ==========================================
async function scanSlowmoon() {
    console.log(`\n🐢 Mengaktifkan radar Slowmoon (Cek 10 Token 24 Jam Terakhir)...`);
    try {
        const output = await runGMGN(`gmgn-cli market trending --chain sol --interval 24h --limit 10`);
        console.log("\n================ [ 🐢 RADAR SLOWMOON ] ================");
        console.log(formatData(output));
        console.log("=======================================================\n");
    } catch (error) {
        console.error("❌ Error cuy:", error.message);
    }
}

// ==========================================
// ☠️ MODE 5: Degen Risk Screening (Top 10)
// ==========================================
async function screenDegenRisks() {
    console.log(`\n☠️ - Narik top 10 token trending buat screening resiko degen...`);
    try {
        let rawOutput = await runGMGN(`gmgn-cli market trending --chain sol --interval 1h --limit 10 --raw`);
        try {
            let jsonObj = JSON.parse(rawOutput);
            if (jsonObj.data && jsonObj.data.rank) {
                // Injeksi nilai total fees yang akurat sebelum dikasih ke AI
                jsonObj.data.rank.forEach(t => t.calculated_total_fees = calculateTotalFees(t) + ' SOL');
            }
            rawOutput = JSON.stringify(jsonObj);
        } catch (e) {}

        const systemPrompt = `Lu adalah crypto degen risk analyst. Tugas lu mengevaluasi data JSON dari 10 token trending di Solana ini berdasarkan kriteria risiko standar GMGN.
        Kriteria:
        - rug_ratio: < 0.1 (Pass), 0.1-0.3 (Watch), > 0.3 (Skip)
        - is_wash_trading: true langsung SKIP.
        - top_10_holder_rate: < 0.2 (Pass), 0.2-0.5 (Watch), > 0.5 (Skip)
        - smart_degen_count: >= 3 (Pass), 1-2 (Watch), 0 (Skip)
        - creator_token_status: creator_close (Pass), creator_hold (Skip/Watch)
        - liquidity: > $50k (Pass), $10k-$50k (Watch), < $10k (Skip)

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

        console.log(`\n================ [ ☠️ DEGEN RISK SCREENING (${activeAgent.toUpperCase()}) ] ================`);
        console.log(formatAIText(aiAnalysis));
        saveLogToFile('risk', formatAIText(aiAnalysis));
        console.log("==============================================================\n");
    } catch (error) {
        console.error("❌ Error cuy:", error.message);
    }
}

// ==========================================
// 💊 MODE 6: Pump.fun Degen Screening
// ==========================================
async function screenDegenRisksPumpfun() {
    console.log(`\n💊 Narik top 10 token trending (Khusus Pump.fun) buat screening resiko degen...`);
    try {
        // Fetch 100 token biar dapet stok token pump yang cukup buat difilter
        let rawOutput = await runGMGN(`gmgn-cli market trending --chain sol --interval 1h --limit 100 --raw`);
        try {
            let jsonObj = JSON.parse(rawOutput);
            if (jsonObj.data && jsonObj.data.rank) {
                // Filter khusus yang CA-nya berakhiran 'pump' dan ambil top 10 doang
                let pumpTokens = jsonObj.data.rank.filter(t => t.address && t.address.endsWith('pump')).slice(0, 10);
                // Injeksi nilai total fees yang akurat sebelum dikasih ke AI
                pumpTokens.forEach(t => t.calculated_total_fees = calculateTotalFees(t) + ' SOL');
                jsonObj.data.rank = pumpTokens;
            }
            rawOutput = JSON.stringify(jsonObj);
        } catch (e) {}

        const systemPrompt = `Lu adalah crypto degen risk analyst. Tugas lu mengevaluasi data JSON dari 10 token trending di Solana (Khusus Pump.fun) ini berdasarkan kriteria risiko standar GMGN. AI juga harus mengevaluasi potensi Bundler dan Konsentrasi Holder.
        Kriteria:
        - rug_ratio: < 0.1 (Pass), 0.1-0.3 (Watch), > 0.3 (Skip)
        - is_wash_trading: true langsung SKIP.
        - top_10_holder_rate: < 20% (Aman), 20%-30% (Waspada), > 30% (Bahaya Bundler/Cabut!)
        - smart_degen_count: >= 3 (Pass), 1-2 (Watch), 0 (Skip)
        - creator_token_status: creator_close (Pass), creator_hold (Skip/Watch)
        - liquidity: > $50k (Pass), $10k-$50k (Watch), < $10k (Skip)

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
           
        Di baris paling bawah, berikan kesimpulan 1-2 token yang paling "aman" untuk di-ape (kalau tidak ada bilang hindari semua).`;

        const aiAnalysis = await askAI(rawOutput, systemPrompt);

        console.log(`\n================ [ 💊 PUMPFUN DEGEN SCREENING (${activeAgent.toUpperCase()}) ] ================`);
        console.log(formatAIText(aiAnalysis));
        saveLogToFile('pumpfun', formatAIText(aiAnalysis));
        console.log("================================================================\n");
    } catch (error) {
        console.error("❌ Error cuy:", error.message);
    }
}

// ==========================================
// 💸 MODE 7: Top Fees Screening (1h / 6h / 24h)
// ==========================================
async function screenTopFees(interval) {
    console.log(`\n💸 Narik data token trending (${interval}) buat cari yang fees-nya paling gila...`);
    try {
        let rawOutput = await runGMGN(`gmgn-cli market trending --chain sol --interval ${interval} --limit 50 --raw`);
        try {
            let jsonObj = JSON.parse(rawOutput);
            if (jsonObj.data && jsonObj.data.rank) {
                // Sort berdasarkan kalkulasi fees terbesar (descending)
                jsonObj.data.rank.sort((a, b) => {
                    return parseFloat(calculateTotalFees(b)) - parseFloat(calculateTotalFees(a));
                });
                
                // Ambil Top 10 aja biar AI fokus
                jsonObj.data.rank = jsonObj.data.rank.slice(0, 10);
                
                // Injeksi string hasilnya buat AI
                jsonObj.data.rank.forEach(t => {
                    t.calculated_total_fees = calculateTotalFees(t) + ' SOL';
                });
            }
            rawOutput = JSON.stringify(jsonObj);
        } catch (e) {}

        const systemPrompt = `Lu adalah crypto degen analyst. Tugas lu mengevaluasi 10 token dengan TOTAL FEES TERBESAR di Solana (interval ${interval}) berdasarkan data JSON ini.
        
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

        console.log(`\n================ [ 💸 TOP FEES SCREENING (${interval.toUpperCase()}) - ${activeAgent.toUpperCase()} ] ================`);
        console.log(formatAIText(aiAnalysis));
        saveLogToFile('fees', formatAIText(aiAnalysis));
        console.log("========================================================================\n");
    } catch (error) {
        console.error("❌ Error cuy:", error.message);
    }
}

// ==========================================
// ⚡ MODE 8: Micro Momentum Scanner (5m / 15m / 30m / 1h)
// ==========================================
async function scanMicroMomentum(interval) {
    console.log(`\n⚡ Narik data token trending (${interval}) buat cari anomali momentum & lonjakan volume...`);
    try {
        let rawOutput = await runGMGN(`gmgn-cli market trending --chain sol --interval ${interval} --limit 15 --raw`);

        const systemPrompt = `Lu adalah Crypto Scalper/Sniper handal. Tugas lu mencari koin yang volume dan harganya mau meledak di timeframe super pendek (${interval}) berdasarkan data JSON ini.
        Fokus cari anomali lonjakan volume mendadak atau buy pressure yang tinggi.
        
        Tampilkan laporan evaluasi momentum secara ringkas:
        **[Nomor]. [Symbol] - [Harga]**
           📍 CA: (Tampilkan address token)
           💰 MC: $(Tampilkan market_cap)
           🚀 Lonjakan ${interval}: (Tampilkan price_change_percent dengan tanda % dan + jika positif)
           💡 Indikasi Sinyal: (Analisa lu apakah buy pressure ini organik atau murni bot wash trading)
           
        Di baris paling bawah, berikan kesimpulan 1-2 token yang momentumnya paling gila dan layak di-snipe sekarang.`;

        const aiAnalysis = await askAI(rawOutput, systemPrompt);

        console.log(`\n================ [ ⚡ MICRO MOMENTUM SCANNER (${interval.toUpperCase()}) - ${activeAgent.toUpperCase()} ] ================`);
        console.log(formatAIText(aiAnalysis));
        saveLogToFile('momentum', formatAIText(aiAnalysis));
        console.log("=================================================================================\n");
    } catch (error) {
        console.error("❌ Error cuy:", error.message);
    }
}

// ==========================================
// 🕵️‍♂️ MODE 9: Creator Wallet Scanner
// ==========================================
async function scanCreatorWallet(creatorAddress) {
    console.log(`\n🕵️‍♂️ Narik data performa wallet dev: ${creatorAddress}...`);
    try {
        let rawOutput = await runGMGN(`gmgn-cli wallet info --chain sol --address ${creatorAddress}`);

        const systemPrompt = `Lu adalah crypto investigator spesialis on-chain. Tugas lu membedah data mentah dari dompet dev ini untuk mencari tanda-tanda 'Serial Rugger'.
        Cari tanda-tanda seperti: win rate sangat rendah, token sering dicabut liquidity-nya, atau total PnL minus parah.
        
        Tampilkan laporan investigasi secara ringkas:
        👤 Wallet Dev: ${creatorAddress}
        📊 Win Rate / PnL: (Tampilkan win rate dalam % / total PnL)
        ☠️ Prediksi Sifat Dev: (Berdasarkan datanya, apakah dia tipe dev yang amanah, jeeter, atau murni serial rugger)
        
        Di baris paling bawah, berikan kesimpulan apakah token dari dev ini layak dibeli atau harus di-blacklist.`;

        const aiAnalysis = await askAI(rawOutput, systemPrompt);

        console.log(`\n================ [ 🕵️‍♂️ CREATOR WALLET SCANNER - ${activeAgent.toUpperCase()} ] ================`);
        console.log(formatAIText(aiAnalysis));
        saveLogToFile('creator', formatAIText(aiAnalysis));
        console.log("=================================================================================\n");
    } catch (error) {
        console.error("❌ Error cuy:", error.message);
    }
}

// ==========================================
// 🤖 HELPER: Pilih Agent AI
// ==========================================
function chooseAgent(callback) {
    console.log(`\n================ [ 🧠 PILIH OTAK AI ] ================`);
    console.log(`1. Groq (Fast, Default)`);
    console.log(`2. Gemini (Google, Smart)`);
    console.log(`3. Ollama (Local, Custom)`);
    console.log(`4. B.AI (Claude/Others)`);
    
    rl.question('👉 Pilih Otak AI (1-4, atau Enter untuk Groq): ', (choice) => {
        if (choice === '1' || choice === '') {
            activeAgent = 'groq';
            console.log(`\n🔄 Otak AI disetel ke: \x1b[32mGROQ\x1b[0m`);
            callback();
        } else if (choice === '2') {
            activeAgent = 'gemini';
            console.log(`\n🔄 Otak AI disetel ke: \x1b[32mGEMINI\x1b[0m`);
            callback();
        } else if (choice === '3') {
            console.log('\n⏳ Cek daftar model dari server Ollama...');
            const tagsUrl = process.env.OLLAMA_TAGS_URL || 'https://ollama.fliw.my.id/api/tags';
            fetch(tagsUrl)
                .then(res => res.json())
                .then(data => {
                    console.log('\n📦 Model Ollama yang tersedia:');
                    data.models.forEach((m, i) => {
                        console.log(`   ${i + 1}. \x1b[36m${m.name}\x1b[0m`);
                    });
                    rl.question(`\n👉 Masukkan nama model atau angka (default: ${activeOllamaModel}): `, (input) => {
                        activeAgent = 'ollama';
                        const val = input.trim();
                        if (val !== '') {
                            const num = parseInt(val);
                            if (!isNaN(num) && num > 0 && num <= data.models.length) {
                                activeOllamaModel = data.models[num - 1].name;
                            } else {
                                activeOllamaModel = val;
                            }
                        }
                        console.log(`\n🔄 Otak AI disetel ke: \x1b[32mOLLAMA (${activeOllamaModel})\x1b[0m`);
                        callback();
                    });
                }).catch(err => {
                    console.log(`\n❌ Gagal ambil list model otomatis (${err.message})`);
                    rl.question(`👉 Ketik nama model manual (default: ${activeOllamaModel}): `, (modelName) => {
                        activeAgent = 'ollama';
                        if (modelName.trim() !== '') activeOllamaModel = modelName.trim();
                        console.log(`\n🔄 Otak AI disetel ke: \x1b[32mOLLAMA (${activeOllamaModel})\x1b[0m`);
                        callback();
                    });
                });
        } else if (choice === '4') {
            const baiUrl = (process.env.BAI_BASE_URL || 'https://api.b.ai/v1').replace(/\/$/, '') + '/models';
            console.log('\n⏳ Cek daftar model dari server B.AI...');
            fetch(baiUrl, {
                headers: {
                    'Authorization': `Bearer ${process.env.BAI_API_KEY || 'missing_api_key'}`,
                    'Content-Type': 'application/json'
                }
            })
            .then(res => {
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                return res.json();
            })
            .then(data => {
                console.log('\n📦 Model B.AI yang tersedia:');
                const models = data.data || [];
                models.forEach((m, i) => {
                    console.log(`   ${i + 1}. \x1b[36m${m.id}\x1b[0m`);
                });
                rl.question(`\n👉 Masukkan nama model atau angka (default: ${activeBaiModel}): `, (input) => {
                    activeAgent = 'bai';
                    const val = input.trim();
                    if (val !== '') {
                        const num = parseInt(val);
                        if (!isNaN(num) && num > 0 && num <= models.length) {
                            activeBaiModel = models[num - 1].id;
                        } else {
                            activeBaiModel = val;
                        }
                    }
                    console.log(`\n🔄 Otak AI disetel ke: \x1b[32mB.AI (${activeBaiModel})\x1b[0m`);
                    callback();
                });
            }).catch(err => {
                console.log(`\n❌ Gagal ambil list model otomatis (${err.message})`);
                rl.question(`👉 Ketik nama model manual (default: ${activeBaiModel}): `, (modelName) => {
                    activeAgent = 'bai';
                    if (modelName.trim() !== '') activeBaiModel = modelName.trim();
                    console.log(`\n🔄 Otak AI disetel ke: \x1b[32mB.AI (${activeBaiModel})\x1b[0m`);
                    callback();
                });
            });
        } else {
            activeAgent = 'groq';
            console.log(`\n❌ Pilihan tidak valid, default ke: \x1b[32mGROQ\x1b[0m`);
            callback();
        }
    });
}

// ==========================================
// 🎮 MENU INTERAKTIF
// ==========================================
function showMenu() {
    let agentStatus = activeAgent.toUpperCase();
    if (activeAgent === 'ollama') {
        agentStatus += ` (${activeOllamaModel})`;
    } else if (activeAgent === 'bai') {
        agentStatus += ` (${activeBaiModel})`;
    }
    console.log(`
🤖 BOTS DEGEN GMGN (DASHBOARD MODE) 🤖
====================
Otak Aktif: \x1b[32m${agentStatus}\x1b[0m
====================
Pilih mode tempur lu:
1. Screening Data 1 Koin (Butuh CA)
2. Auto-Hunting (Cek 3 Token Trending)
3. Meta Scanner (AI Powered)
4. Slowmoon Radar (Cek Data Harian)
5. Degen Risk Screening (Top 10 & Analisa Risiko)
6. Pumpfun Degen Screening (Khusus akhiran pump)
7. Top Fees Screening (Cari Token Fee Terbesar - 1h/6h/24h)
8. Micro-Momentum Radar (5m / 15m / 30m / 1h)
9. Creator Wallet Scanner (Wallet Address Needed)
10. Switch Agent AI
11. Exit
====================`);
    
    rl.question('Masukkan pilihan (1-11): ', (answer) => {
        if (answer === '1') {
            rl.question('👉 Masukkan CA Token: ', async (ca) => {
                await screenSpecificCA(ca);
                showMenu();
            });
        } else if (answer === '2') {
            (async () => {
                await autoHuntTokens();
                showMenu();
            })();
        } else if (answer === '3') {
            (async () => {
                await scanCurrentMeta();
                showMenu();
            })();
        } else if (answer === '4') {
            (async () => {
                await scanSlowmoon();
                showMenu();
            })();
        } else if (answer === '5') {
            (async () => {
                await screenDegenRisks();
                showMenu();
            })();
        } else if (answer === '6') {
            (async () => {
                await screenDegenRisksPumpfun();
                showMenu();
            })();
        } else if (answer === '7') {
            rl.question('👉 Pilih timeframe (5m / 15m / 30m / 1h / 6h / 24h): ', async (interval) => {
                const validIntervals = ['5m', '15m', '30m', '1h', '6h', '24h'];
                if (validIntervals.includes(interval.toLowerCase())) {
                    await screenTopFees(interval.toLowerCase());
                } else {
                    console.log('❌ Timeframe ga valid! Coba ketik 1h, 6h, atau 24h.');
                }
                showMenu();
            });
        } else if (answer === '8') {
            rl.question('👉 Pilih timeframe (1m / 5m / 15m / 30m / 1h): ', async (interval) => {
                const validIntervals = ['1m', '5m', '15m', '30m', '1h'];
                if (validIntervals.includes(interval.toLowerCase())) {
                    await scanMicroMomentum(interval.toLowerCase());
                } else {
                    console.log('❌ Timeframe ga valid! Coba ketik 5m atau 15m.');
                }
                showMenu();
            });
        } else if (answer === '9') {
            rl.question('👉 Masukkan Address Dompet Creator: ', async (address) => {
                await scanCreatorWallet(address);
                showMenu();
            });
        } else if (answer === '10') {
            chooseAgent(showMenu);
        } else if (answer === '11') {
            console.log('Caw! Keluar dari trenches...');
            rl.close();
            process.exit(0);
        } else {
            console.log('Pilihan ga valid bro, masukin angka 1 sampe 11 aja.');
            showMenu();
        }
    });
}

console.log("Menyiapkan amunisi...");
chooseAgent(showMenu);