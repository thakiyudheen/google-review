import { addExtra } from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import chromium from '@sparticuz/chromium';
import fs from 'fs';
import path from 'path';
import express from 'express';
import morgan from 'morgan';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

import puppeteerCore from 'puppeteer-core';
const puppeteer = addExtra(puppeteerCore);

puppeteer.use(StealthPlugin());

const app = express();
app.use(morgan('dev')); // HTTP request logger

const PORT = process.env.PORT || 3003;

// ---------------------------------------------------------------------------
// BROWSER LAUNCH LOGIC (updated for reliable Vercel/serverless deployment)
// ---------------------------------------------------------------------------
async function getBrowser() {
    // process.env.VERCEL is set automatically by Vercel on every deployment
    // (production AND preview), which is more reliable than NODE_ENV alone.
    let isServerless = process.env.NODE_ENV === 'production' || !!process.env.VERCEL;

    // Safety fallback: if we think we're local but no local Chrome exists on disk,
    // force serverless mode anyway.
    if (!isServerless) {
        try {
            const localPuppeteer = (await import('puppeteer')).default;
            const execPath = localPuppeteer.executablePath();
            fs.accessSync(execPath, fs.constants.X_OK);
        } catch (e) {
            isServerless = true;
        }
    }

    let launchArgs;
    let executablePath;
    let defaultViewport;
    let headless;

    if (isServerless) {
        // Reduce memory footprint — Google Maps is graphics-heavy and
        // Vercel functions are memory constrained.
        chromium.setGraphicsMode = false;

        launchArgs = [
            ...chromium.args,
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--lang=en-US',
            '--window-size=1280,800',
            '--disable-blink-features=AutomationControlled',
            // Vercel's /dev/shm is tiny; without this Chromium can crash
            // mid-render on heavier pages.
            '--disable-dev-shm-usage',
        ];
        executablePath = await chromium.executablePath();
        defaultViewport = chromium.defaultViewport;
        headless = chromium.headless;
    } else {
        // Local dev: full puppeteer with your machine's Chrome
        const localPuppeteer = (await import('puppeteer')).default;
        launchArgs = [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--lang=en-US',
            '--window-size=1280,800',
            '--disable-blink-features=AutomationControlled',
        ];
        executablePath = localPuppeteer.executablePath();
        defaultViewport = { width: 1280, height: 800 };
        headless = process.env.HEADLESS !== 'false';
    }

    return puppeteer.launch({
        args: launchArgs,
        defaultViewport,
        executablePath,
        headless,
        ignoreDefaultArgs: ['--enable-automation'],
    });
}
// ---------------------------------------------------------------------------
// END BROWSER LAUNCH LOGIC — everything below is unchanged
// ---------------------------------------------------------------------------

export async function scrapeGoogleMapsReviews(targetUrl) {
    console.log('Launching Puppeteer to scrape Google Maps Reviews...');

    const browser = await getBrowser();

    const page = await browser.newPage();
    // Enforce a strict Desktop User-Agent to prevent Google Maps from serving the stripped down/mobile layout
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.setViewport({ width: 1280, height: 800 });

    try {
        console.log(`Navigating to Google Maps...`);
        // Navigate to the provided Google Maps URL
        await page.goto(targetUrl, { waitUntil: 'networkidle2' });

        console.log(`Navigated to Google Map with Url...`);

        // Wait a random amount of time
        await new Promise(r => setTimeout(r, 2000 + Math.random() * 2000));

        // Accept cookies if the dialog appears
        try {
            const acceptBtn = await page.$('button[aria-label="Accept all"]');
            if (acceptBtn) {
                await acceptBtn.click();
                await new Promise(resolve => setTimeout(resolve, 2000));
                console.log('Accepted cookies.');
            }
        } catch (e) { }

        // Wait for the side panel to load
        await page.waitForSelector('h1', { timeout: 15000 });

        console.log('Looking for the "Reviews" tab...');
        let clickedReviews = false;

        const tryFindReviewsTab = async () => {
            const tabs = await page.$$('button[role="tab"]');
            for (const tab of tabs) {
                const text = await page.evaluate(el => el.textContent, tab);
                if (text && text.includes('Reviews')) {
                    await tab.click();
                    return true;
                }
            }
            return false;
        };

        // Try for up to 5 seconds to find the reviews tab or fallback (handling slow DOM renders)
        for (let attempt = 0; attempt < 5; attempt++) {
            clickedReviews = await tryFindReviewsTab();
            if (clickedReviews) break;

            try {
                const fallbackBtn = await page.$('.wiquBf');
                if (fallbackBtn) {
                    console.log('Reviews tab not found immediately. Trying .wiquBf fallback...');
                    await fallbackBtn.click();
                    console.log('Clicked .wiquBf fallback, waiting for UI to update...');
                    await new Promise(r => setTimeout(r, 2000));
                    clickedReviews = await tryFindReviewsTab();
                    if (clickedReviews) break;
                }
            } catch (e) {
                console.log('Error clicking fallback:', e.message);
            }

            console.log(`Reviews tab not found on attempt ${attempt + 1}. Waiting 1 second...`);
            await new Promise(r => setTimeout(r, 1000));
        }

        if (clickedReviews) {
            console.log('Successfully opened Reviews section.');
        } else {
            console.log('Could not find the "Reviews" tab. Taking a screenshot for debugging...');
            const screenshotBuffer = await page.screenshot({ fullPage: true });
            await browser.close();

            // If the user is running this via Express, they can return the image directly!
            // But since this function is extracted, we can throw an error with the buffer,
            // or just save it to /tmp if serverless.
            // Wait, this is inside `scrapeGoogleMapsReviews` which returns data.
            // We can throw a custom error to handle it in the Express route!
            const error = new Error('Could not find the "Reviews" tab');
            error.screenshot = screenshotBuffer;
            throw error;
        }

        // Wait briefly for the reviews to load fully before scrolling
        console.log('Waiting 3 seconds for reviews to render...');
        await new Promise(r => setTimeout(r, 3000));

        // Scroll the reviews panel to load more
        console.log('Scrolling to load reviews...');
        const isServerlessForScroll = process.env.NODE_ENV === 'production' || !!process.env.VERCEL;
        const scrollIterations = isServerlessForScroll ? 20 : 60; // Max 60 seconds on Vercel, reduce scrolls to finish in time
        await page.evaluate(async (iterations) => {
            for (let i = 0; i < iterations; i++) {
                // 1. Try scrolling by the user's explicit class just in case
                const scrollableDiv = document.querySelector('.m6QErb.DxyBCb.kA9KIf.dS8AEf.XiKgde')
                    || document.querySelector('.m6QErb.DxyBCb.kA9KIf.dS8AEf')
                    || document.querySelector('div[role="main"]');
                if (scrollableDiv) {
                    scrollableDiv.scrollBy(0, 5000);
                }

                // 2. The most foolproof way: find the last review currently loaded and scroll it into view!
                const loadedReviews = document.querySelectorAll('div[data-review-id]');
                if (loadedReviews.length > 0) {
                    loadedReviews[loadedReviews.length - 1].scrollIntoView();
                }

                // Wait for network/lazy load
                await new Promise(resolve => setTimeout(resolve, 1500));
            }
        }, scrollIterations);

        console.log('Clicking "More" buttons on long reviews...');
        await page.evaluate(async () => {
            const moreButtons = document.querySelectorAll('button.w8nwRe');
            for (const btn of moreButtons) {
                if (btn.innerText.includes('More')) {
                    btn.click();
                    // Small delay to allow text expansion
                    await new Promise(r => setTimeout(r, 100));
                }
            }
        });

        console.log('Extracting review details directly from the list...');
        const rawReviews = await page.evaluate(async () => {
            const results = [];
            // Google Maps review container classes
            const reviewElements = Array.from(document.querySelectorAll('.jftiEf, div[data-review-id]'));
            const delay = ms => new Promise(res => setTimeout(res, ms));

            for (const el of reviewElements) {
                // 1. Reviewer Name (.d4r55 is commonly used for name in the list)
                const nameEl = el.querySelector('.d4r55') || el.querySelector('.XjcHXc');
                let name = nameEl ? nameEl.textContent.trim() : 'Unknown';

                // 2. Profile Photo
                const photoEl = el.querySelector('.NBa7we');
                let profilePhoto = photoEl ? photoEl.src : '';

                // 3. Profile Link (often in a button or anchor wrapper)
                const linkEl = el.querySelector('a[href*="/contrib/"], button[data-href*="/contrib/"]');
                let profileLink = '';
                if (linkEl) {
                    profileLink = linkEl.getAttribute('href') || linkEl.getAttribute('data-href');
                }

                // 4. Date
                const dateEl = el.querySelector('.rsqaWe');
                let rawDate = dateEl ? dateEl.textContent.trim() : '';

                // 5. Rating
                const ratingEl = el.querySelector('.kvMYJc');
                let rating = 'N/A';
                if (ratingEl) {
                    const ariaLabel = ratingEl.getAttribute('aria-label');
                    if (ariaLabel) {
                        rating = ariaLabel.replace(/[^0-9.]/g, '');
                    }
                }

                // 6. Review Text
                const textEl = el.querySelector('.MyEned span.wiI7pd');
                let currentText = textEl ? textEl.textContent.trim() : '';
                let reviewTextOriginal = currentText;
                let reviewTextTranslated = '';

                // Look for translate/original button
                const buttons = Array.from(el.querySelectorAll('button'));
                const translateBtn = buttons.find(b => {
                    const txt = b.textContent.toLowerCase();
                    return txt.includes('original') || txt.includes('translate');
                });

                if (translateBtn) {
                    const isShowingTranslated = translateBtn.textContent.toLowerCase().includes('original');

                    translateBtn.click();
                    await delay(300); // Wait for DOM update

                    const newTextEl = el.querySelector('.MyEned span.wiI7pd');
                    const otherText = newTextEl ? newTextEl.textContent.trim() : '';

                    if (isShowingTranslated) {
                        reviewTextTranslated = currentText;
                        reviewTextOriginal = otherText;
                    } else {
                        reviewTextOriginal = currentText;
                        reviewTextTranslated = otherText;
                    }
                }

                if (name !== 'Unknown' && rawDate !== '') {
                    results.push({
                        reviewerName: name,
                        profilePhoto: profilePhoto,
                        profileLink: profileLink,
                        dateOfReviewRaw: rawDate,
                        rating: rating,
                        reviewTextOriginal: reviewTextOriginal,
                        reviewTextTranslated: reviewTextTranslated
                    });
                }
            }
            return results;
        });

        // Date Conversion Logic Helper
        const processDate = (rawDate) => {
            if (!rawDate) return { text: '', dateObj: new Date(0) };
            const now = new Date();
            let date = new Date();

            if (rawDate.includes('a day ago') || rawDate.includes('1 day ago')) {
                date.setDate(now.getDate() - 1);
            } else if (rawDate.includes('days ago')) {
                const days = parseInt(rawDate.split(' ')[0]);
                if (!isNaN(days)) date.setDate(now.getDate() - days);
            } else if (rawDate.includes('a month ago') || rawDate.includes('1 month ago')) {
                date.setMonth(now.getMonth() - 1);
            } else if (rawDate.includes('months ago')) {
                const months = parseInt(rawDate.split(' ')[0]);
                if (!isNaN(months)) date.setMonth(now.getMonth() - months);
            } else if (rawDate.includes('a year ago') || rawDate.includes('1 year ago')) {
                date.setFullYear(now.getFullYear() - 1);
            } else if (rawDate.includes('years ago')) {
                const years = parseInt(rawDate.split(' ')[0]);
                if (!isNaN(years)) date.setFullYear(now.getFullYear() - years);
            } else if (rawDate.includes('a week ago') || rawDate.includes('1 week ago')) {
                date.setDate(now.getDate() - 7);
            } else if (rawDate.includes('weeks ago')) {
                const weeks = parseInt(rawDate.split(' ')[0]);
                if (!isNaN(weeks)) date.setDate(now.getDate() - (weeks * 7));
            } else if (rawDate.includes('an hour ago') || rawDate.includes('hours ago') || rawDate.includes('mins ago')) {
                date = now;
            }

            const month = String(date.getMonth() + 1).padStart(2, '0');
            const day = String(date.getDate()).padStart(2, '0');
            const year = date.getFullYear();
            return { text: `${month}/${day}/${year}`, dateObj: date };
        };

        const extractedReviews = [];
        for (const r of rawReviews) {
            const dateParsed = processDate(r.dateOfReviewRaw);
            extractedReviews.push({
                "name": r.reviewerName,
                "profile Photo": r.profilePhoto,
                "LInk to review": r.profileLink,
                "Date of review": dateParsed.text,
                "Ratings": r.rating,
                "Reveiw text orginal": r.reviewTextOriginal,
                "Review text translated": r.reviewTextTranslated,
                _dateObj: dateParsed.dateObj
            });
        }

        console.log('Deduplicating reviews...');
        const uniqueReviewsMap = new Map();
        for (const r of extractedReviews) {
            // Create a unique key using name and text to prevent duplicates
            const uniqueKey = `${r["name"]}_${r["Reveiw text orginal"]}`;
            if (!uniqueReviewsMap.has(uniqueKey)) {
                uniqueReviewsMap.set(uniqueKey, r);
            }
        }
        const uniqueReviews = Array.from(uniqueReviewsMap.values());

        console.log('Sorting reviews by date...');
        // Sort descending (newest first)
        uniqueReviews.sort((a, b) => b._dateObj - a._dateObj);

        // Remove the hidden sorting property before saving
        const finalReviews = uniqueReviews.map(r => {
            delete r._dateObj;
            return r;
        });

        console.log(`Successfully extracted ${finalReviews.length} reviews.`);

        return finalReviews;

    } catch (error) {
        console.error('Error occurred during scraping:', error);
        throw error;
    } finally {
        await browser.close();
        console.log('Browser closed.');
    }
}

app.get('/', (req, res) => {
    res.json({
        service: "Google Maps Review Scraper API",
        status: "online",
        usage: {
            endpoint: "/scrape",
            method: "GET",
            description: "Triggers the puppeteer scraper and automatically downloads the JSON file with the reviews.",
            query_parameters: {
                url: "(optional) The Google Maps URL of the business to scrape. If not provided, defaults to Jobbatical."
            },
            example_usage: "http://localhost:3003/scrape?url=YOUR_GOOGLE_MAPS_URL"
        }
    });
});

app.get('/scrape', async (req, res) => {
    // Default URL to the Jobbatical Google Maps location
    const defaultUrl = 'https://www.google.com/maps/place/Jobbatical/@59.4376249,24.7559448,17z/data=!4m12!1m2!2m1!1sSoftware+company!3m8!1s0x4692937dee7b8119:0x537449c59c834621!8m2!3d59.4376223!4d24.7608157!9m1!1b1!15sChBTb2Z0d2FyZSBjb21wYW55WhIiEHNvZnR3YXJlIGNvbXBhbnmSARBzb2Z0d2FyZV9jb21wYW554AEA!16s%2Fg%2F11b6q8qc67?entry=ttu&g_ep=EgoyMDI2MDYyOS4wIKXMDSoASAFQAw%3D%3D';
    const targetUrl = req.query.url || defaultUrl;

    try {
        console.log(`Starting scrape request for URL: ${targetUrl}`);
        const finalReviews = await scrapeGoogleMapsReviews(targetUrl);

        // Send the JSON as a downloadable attachment directly from memory
        res.setHeader('Content-Disposition', 'attachment; filename="google_maps_detailed_reviews.json"');
        res.setHeader('Content-Type', 'application/json');
        res.send(JSON.stringify(finalReviews, null, 2));
    } catch (error) {
        console.error('Scraping failed:', error);
        if (!res.headersSent) {
            if (error.screenshot) {
                // Return an HTML page with the screenshot embedded so it perfectly renders in the browser
                const base64Image = error.screenshot.toString('base64');
                res.setHeader('Content-Type', 'text/html');
                res.send(`
                    <div style="font-family: sans-serif; padding: 20px;">
                        <h2 style="color: red;">Scraping Failed: Reviews tab not found</h2>
                        <p>Here is exactly what the bot saw on Google Maps when it failed:</p>
                        <img src="data:image/png;base64,${base64Image}" style="max-width: 100%; border: 1px solid #ccc; box-shadow: 0 4px 8px rgba(0,0,0,0.1);" />
                    </div>
                `);
            } else {
                res.status(500).json({ error: 'Failed to scrape reviews', details: error.message });
            }
        }
    }
});

const isMainModule = import.meta.url.startsWith('file:') && process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
    const server = app.listen(PORT, () => {
        console.log(`Server is running! API is available at http://localhost:${PORT}`);
        console.log(`Trigger a scrape by visiting: http://localhost:${PORT}/scrape`);
        console.log(`To use a custom URL: http://localhost:${PORT}/scrape?url=YOUR_GOOGLE_MAPS_URL`);
    });

    server.on('error', (error) => {
        console.error('❌ Error starting server:', error.message);
        if (error.code === 'EADDRINUSE') {
            console.error(`➡️ Port ${PORT} is already in use. Please stop the other server or change the port.`);
        }
        process.exit(1);
    });
}

export default app;