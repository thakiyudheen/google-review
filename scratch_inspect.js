import { addExtra } from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import puppeteerCore from 'puppeteer-core';
import chromium from '@sparticuz/chromium';

const puppeteer = addExtra(puppeteerCore);
puppeteer.use(StealthPlugin());

(async () => {
    try {
        const localPuppeteer = (await import('puppeteer')).default;
        const browser = await puppeteer.launch({
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--lang=en-US',
                '--window-size=1280,800',
                '--disable-blink-features=AutomationControlled'
            ],
            defaultViewport: { width: 1280, height: 800 },
            executablePath: localPuppeteer.executablePath(),
            headless: "shell", // test old headless
            ignoreDefaultArgs: ['--enable-automation']
        });
        const page = await browser.newPage();
        // Setting a realistic User-Agent is sometimes critical in headless
        await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        
        await page.goto('https://www.google.com/maps/place/Jobbatical/@59.4376249,24.7559448,17z/data=!4m12!1m2!2m1!1sSoftware+company!3m8!1s0x4692937dee7b8119:0x537449c59c834621!8m2!3d59.4376223!4d24.7608157!9m1!1b1!15sChBTb2Z0d2FyZSBjb21wYW55WhIiEHNvZnR3YXJlIGNvbXBhbnmSARBzb2Z0d2FyZV9jb21wYW554AEA!16s%2Fg%2F11b6q8qc67?entry=ttu&g_ep=EgoyMDI2MDYyOS4wIKXMDSoASAFQAw%3D%3D', { waitUntil: 'networkidle2' });
        
        await new Promise(r => setTimeout(r, 3000));
        
        const buttons = await page.$$eval('button', btns => btns.map(b => b.textContent.trim()).filter(t => t));
        const tabs = await page.$$eval('[role="tab"]', tabs => tabs.map(t => ({ text: t.textContent.trim(), tag: t.tagName })));
        const htmlSnippet = await page.evaluate(() => document.body.innerHTML.substring(0, 500));
        
        console.log('--- BUTTONS ---');
        console.log(buttons.slice(0, 20).join(', '));
        console.log('--- TABS ---');
        console.log(JSON.stringify(tabs, null, 2));
        
        await browser.close();
    } catch (e) {
        console.error(e);
    }
})();
