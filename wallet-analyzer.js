require('dotenv').config();
const readline = require('readline');
const { exec } = require('child_process');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// Inisialisasi Otak Gemini
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

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

const delay = ms => new Promise(res => setTimeout(res, ms));

async function askGemini(rawData, customPrompt, retries = 3) {
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" }); 
    const finalPrompt = `${customPrompt}\n\nBerikut adalah data mentah JSON-nya:\n${rawData}`;
    
    for (let i = 0; i < retries; i++) {
        try {
            const result = await model.generateContent(finalPrompt);
            return result.response.text();
        } catch (error) {
            if (error.message && error.message.includes('503')) {
                console.log(`\x1b[33m⏳ Server AI sibuk (503). Coba lagi dalam ${(i + 1) * 2} detik... (Percobaan ${i + 1}/${retries})\x1b[0m`);
                await delay((i + 1) * 2000);
                continue;
            }
            return `❌ Gagal mikir AI-nya: ${error.message}`;
        }
    }
    return `❌ AI-nya nyerah bro (Server penuh). Coba lagi nanti!`;
}

function formatAIText(text) {
    return text
        .replace(/\*\*(.*?)\*\*/g, '\x1b[1m\x1b[36m$1\x1b[0m')
        .replace(/🟢/g, '\x1b[32m🟢\x1b[0m')
        .replace(/🔴/g, '\x1b[31m🔴\x1b[0m')
        .replace(/🟡/g, '\x1b[33m🟡\x1b[0m')
        .replace(/📈 Win Rate \/ PNL:/g, '\x1b[35m📈 Win Rate / PNL:\x1b[0m')
        .replace(/💰 PNL Realized \/ Unrealized:/g, '\x1b[33m💰 PNL Realized / Unrealized:\x1b[0m')
        .replace(/💸 Total Spent:/g, '\x1b[31m💸 Total Spent:\x1b[0m')
        .replace(/🛒 Rasio Buy\/Sell:/g, '\x1b[34m🛒 Rasio Buy/Sell:\x1b[0m')
        .replace(/🏆 Top Holdings:/g, '\x1b[36m🏆 Top Holdings:\x1b[0m')
        .replace(/💡 KESIMPULAN:/g, '\x1b[32m💡 KESIMPULAN:\x1b[0m');
}

async function analyzeWallet(walletAddress) {
    console.log(`\n🕵️‍♂️ Narik data riwayat & isi dompet (holdings) address: ${walletAddress}...`);
    try {
        console.log(`⏳ Fetching stats 7 hari terakhir...`);
        const statsOutput = await runGMGN(`gmgn-cli portfolio stats --chain sol --wallet ${walletAddress}`);
        
        console.log(`⏳ Fetching top 10 koin yang di-hold...`);
        const holdingsOutput = await runGMGN(`gmgn-cli portfolio holdings --chain sol --wallet ${walletAddress} --limit 10`);
        
        const rawData = `[DATA STATS 7 HARI]\n${statsOutput}\n\n[DATA TOP 10 HOLDINGS]\n${holdingsOutput}`;
        
        const systemPrompt = `Lu adalah analis wallet crypto (copy-trade expert). Tugas lu membedah performa wallet Solana ini berdasarkan data JSON "STATS" dan "HOLDINGS" dari GMGN.
        
        Tampilkan laporan evaluasi performa wallet secara ringkas:
        **[Profil Wallet] - ${walletAddress}**
           📈 Win Rate / PNL: (Ubah winrate jadi persentase, misal 0.6 = 60%) / (Tampilkan angka pnl diikuti 'x')
           💰 PNL Realized / Unrealized: $(Tampilkan realized_profit) / $(Tampilkan unrealized_profit)
           💸 Total Spent: $(Tampilkan total_cost)
           🛒 Rasio Buy/Sell: (Tampilkan buy_count) / (Tampilkan sell_count)
           
           🏆 Top Holdings (Maks 3 koin dengan usd_value paling gede):
             1. [Symbol] - Nilai: $[usd_value] | PNL: [profit_change]x
             2. [Symbol] - Nilai: $[usd_value] | PNL: [profit_change]x
             3. [Symbol] - Nilai: $[usd_value] | PNL: [profit_change]x
           
        💡 KESIMPULAN: (Analisa gaya mainnya. Apakah dia sniper, diamond hand, atau malah jelek winrate-nya? Berikan rekomendasi pakai bahasa degen crypto apakah wallet ini layak di-copytrade, di-watch, atau skip aja.)`;

        console.log(`\n🤖 Sabar, AI lagi ngebedah portfolio wallet-nya...`);
        const aiAnalysis = await askGemini(rawData, systemPrompt);

        console.log("\n================ [ 🧠 SMART WALLET ANALYZER ] ================");
        console.log(formatAIText(aiAnalysis));
        console.log("==============================================================\n");
    } catch (error) {
        console.error("❌ Error cuy:", error.message);
    }
}

function askWallet() {
    rl.question('\n👉 Masukkan Address Wallet (atau ketik "exit" buat keluar): ', async (address) => {
        if (address.toLowerCase() === 'exit') {
            console.log('Caw! Keluar dari analyzer...');
            rl.close();
            process.exit(0);
        } else {
            await analyzeWallet(address);
            askWallet(); // Loop lagi
        }
    });
}

console.log("💼 GMGN SMART WALLET TRACKER & ANALYZER 💼");
askWallet();