const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');
const path = require('path');
const express = require('express');
const morgan = require('morgan');

// Force Vercel's bundler to include dynamic dependencies
try {
  require('fs-extra');
  require('puppeteer-extra-plugin-stealth/evasions/chrome.app');
  require('puppeteer-extra-plugin-stealth/evasions/chrome.csi');
  require('puppeteer-extra-plugin-stealth/evasions/chrome.loadTimes');
  require('puppeteer-extra-plugin-stealth/evasions/chrome.runtime');
  require('puppeteer-extra-plugin-stealth/evasions/defaultArgs');
  require('puppeteer-extra-plugin-stealth/evasions/iframe.contentWindow');
  require('puppeteer-extra-plugin-stealth/evasions/media.codecs');
  require('puppeteer-extra-plugin-stealth/evasions/navigator.hardwareConcurrency');
  require('puppeteer-extra-plugin-stealth/evasions/navigator.languages');
  require('puppeteer-extra-plugin-stealth/evasions/navigator.permissions');
  require('puppeteer-extra-plugin-stealth/evasions/navigator.plugins');
  require('puppeteer-extra-plugin-stealth/evasions/navigator.vendor');
  require('puppeteer-extra-plugin-stealth/evasions/navigator.webdriver');
  require('puppeteer-extra-plugin-stealth/evasions/sourceurl');
  require('puppeteer-extra-plugin-stealth/evasions/user-agent-override');
  require('puppeteer-extra-plugin-stealth/evasions/webgl.vendor');
  require('puppeteer-extra-plugin-stealth/evasions/window.outerdimensions');
  require('puppeteer-extra-plugin-user-preferences');
  require('puppeteer-extra-plugin-user-data-dir');
} catch (e) {}

puppeteer.use(StealthPlugin());

const app = express();
app.use(morgan('dev')); // HTTP request logger

const PORT = process.env.PORT || 3003;

async function scrapeGoogleMapsReviews(targetUrl) {
    console.log('Launching Puppeteer to scrape Google Maps Reviews...');

    const browser = await puppeteer.launch({
        // headless: true, // Run headless to hide the browser window
        // Save browser data (cookies, login session) in a local folder so you stay logged in
        userDataDir: path.join(__dirname, 'chrome_session'),
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--lang=en-US',
            '--window-size=1280,800',
            '--disable-blink-features=AutomationControlled'
        ],
        ignoreDefaultArgs: ['--enable-automation']
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });

    try {
        console.log(`Navigating to Google Maps...`);
        // Navigate to the provided Google Maps URL
        await page.goto(targetUrl, { waitUntil: 'networkidle2' });

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
        const tabs = await page.$$('button[role="tab"]');
        let clickedReviews = false;
        for (const tab of tabs) {
            const text = await page.evaluate(el => el.textContent, tab);
            if (text && text.includes('Reviews')) {
                await tab.click();
                clickedReviews = true;
                console.log('Clicked "Reviews" tab.');
                break;
            }
        }

        if (!clickedReviews) {
            console.log('Could not find the "Reviews" tab. Reviews might be further down or on a different layout.');
        }

        // Wait a longer time to allow manual interaction if a captcha or cookie banner blocks it
        console.log('Waiting 30 seconds. If you see a Cookie dialog, Captcha, or want to log in to Google, please do it manually now...');
        await new Promise(r => setTimeout(r, 30000));

        // Scroll the reviews panel to load more
        console.log('Scrolling to load reviews (aiming for up to 150+)...');
        await page.evaluate(async () => {
            for (let i = 0; i < 60; i++) {
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
        });

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
            res.status(500).json({ error: 'Failed to scrape reviews', details: error.message });
        }
    }
});

if (require.main === module) {
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

module.exports = app;
