const { test, expect } = require("@playwright/test");
const fs = require("fs");
const path = require("path");
const { PNG } = require("pngjs");
const sharp = require("sharp");
const config = require("../config.js");

let pixelmatch;
let chalk;

// Dynamically load `pixelmatch` and `chalk`
(async () => {
  pixelmatch = (await import("pixelmatch")).default;
  chalk = (await import("chalk")).default;
})();

// Helper Functions

// Ensure directory exists
function ensureDirectoryExistence(filePath) {
  const dirname = path.dirname(filePath);
  if (!fs.existsSync(dirname)) {
    fs.mkdirSync(dirname, { recursive: true });
  }
}

// Convert image to Base64
function imageToBase64(imagePath) {
  if (fs.existsSync(imagePath)) {
    const imageData = fs.readFileSync(imagePath).toString("base64");
    const ext = path.extname(imagePath).replace(".", ""); // Get file extension (e.g., png)
    return `data:image/${ext};base64,${imageData}`;
  }
  return null; // Return null if image is missing
}

// Resize images to match specified dimensions (1280x800)
async function resizeImage(imagePath, width, height) {
  const buffer = fs.readFileSync(imagePath);
  const resizedBuffer = await sharp(buffer)
    .resize(width, height, {
      fit: "contain",
      background: { r: 255, g: 255, b: 255, alpha: 0 },
    })
    .toBuffer();
  fs.writeFileSync(imagePath, resizedBuffer);
}

// Compare two screenshots and return similarity percentage
async function compareScreenshots(baselinePath, currentPath, diffPath) {
  if (!fs.existsSync(baselinePath) || !fs.existsSync(currentPath)) {
    console.log(
      chalk.red(`Missing file(s): ${baselinePath} or ${currentPath}`)
    );
    return "Error";
  }

  await resizeImage(baselinePath, 1280, 800);
  await resizeImage(currentPath, 1280, 800);

  const img1 = PNG.sync.read(fs.readFileSync(baselinePath)); // Staging
  const img2 = PNG.sync.read(fs.readFileSync(currentPath)); // Prod

  if (img1.width !== img2.width || img1.height !== img2.height) {
    console.log(
      chalk.red(`Size mismatch for ${baselinePath} and ${currentPath}`)
    );
    return "Size mismatch";
  }

  const diff = new PNG({ width: img1.width, height: img1.height });

  pixelmatch(img1.data, img2.data, diff.data, img1.width, img1.height, {
    threshold: 0.1,
    diffColor: [0, 0, 255], // Blue for Prod Differences
    diffColorAlt: [255, 165, 0], // Orange for Staging Differences
  });

  fs.writeFileSync(diffPath, PNG.sync.write(diff));

  const totalPixels = img1.width * img1.height;
  const mismatchedPixels = pixelmatch(
    img1.data,
    img2.data,
    null,
    img1.width,
    img1.height,
    { threshold: 0.1 }
  );

  const matchedPixels = totalPixels - mismatchedPixels;
  return (matchedPixels / totalPixels) * 100;
}

// Capture screenshot for a given URL
async function captureScreenshot(page, url, screenshotPath) {
  try {
    console.log(chalk.blue(`Navigating to: ${url}`));
    await page.goto(url, { waitUntil: "networkidle", timeout: 60000 });

    ensureDirectoryExistence(screenshotPath);
    await page.screenshot({ path: screenshotPath, fullPage: true });
    console.log(chalk.green(`Screenshot captured: ${screenshotPath}`));
  } catch (error) {
    console.error(
      chalk.red(`Failed to capture screenshot for ${url}: ${error.message}`)
    );
  }
}

// Generate HTML report with Base64 embedded images
function generateHtmlReport(results, deviceName) {
  const reportPath = `visual_comparison_report_${deviceName}.html`;
  const now = new Date().toLocaleString();

  // Count passed, failed, and errors
  const passed = results.filter(
    (r) =>
      typeof r.similarityPercentage === "number" && r.similarityPercentage >= 95
  ).length;
  const failed = results.filter(
    (r) =>
      typeof r.similarityPercentage === "number" && r.similarityPercentage < 95
  ).length;
  const errors = results.filter(
    (r) => r.similarityPercentage === "Error"
  ).length;

  // **SORT RESULTS: Failed first, then errors, then passed**
  results.sort((a, b) => {
    if (a.similarityPercentage === "Error") return -1;
    if (b.similarityPercentage === "Error") return 1;
    if (
      typeof a.similarityPercentage === "number" &&
      typeof b.similarityPercentage === "number"
    ) {
      return a.similarityPercentage - b.similarityPercentage; // Lower similarity first
    }
    return 0;
  });

  let htmlContent = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <title>Visual Comparison Report - ${deviceName}</title>
      <style>
        body { font-family: Arial, sans-serif; margin: 20px; }
        h1, h2 { text-align: center; }
        .summary { text-align: center; margin-bottom: 20px; }
        .summary p { font-size: 16px; }
        .summary span { font-weight: bold; }
        .summary .passed { color: green; }
        .summary .failed { color: red; }
        .summary .errors { color: orange; }
        .staging { color: orange; font-weight: bold; }
        .prod { color: blue; font-weight: bold; }
        table { width: 100%; border-collapse: collapse; margin-top: 20px; }
        th, td { border: 1px solid #ddd; padding: 8px; text-align: center; vertical-align: middle; }
        th { background-color: #f2f2f2; }
        .image-container { display: flex; justify-content: center; align-items: center; gap: 15px; }
        .image-wrapper { display: flex; flex-direction: column; align-items: center; }
        .image-container img { width: 350px; cursor: pointer; border: 1px solid #ddd; }
        .image-label { font-size: 14px; font-weight: bold; margin-top: 5px; text-align: center; }
        .status-pass { color: green; font-weight: bold; }
        .status-fail { color: red; font-weight: bold; }
        .status-error { color: orange; font-weight: bold; }
        .criteria { font-size: 14px; text-align: center; margin-top: 10px; font-weight: bold; }
        .modal { display: none; position: fixed; z-index: 1000; left: 0; top: 0; width: 100%; height: 100%; background-color: rgba(0,0,0,0.8); }
        .modal img { display: block; max-width: 90%; max-height: 90%; margin: auto; }
        .modal-close { position: absolute; top: 20px; right: 30px; font-size: 30px; color: white; cursor: pointer; }
      </style>
    </head>
    <body>
      <h1>Visual Comparison Report</h1>
      <h2>Device: ${deviceName}</h2>
      <div class="summary">
        <p><span class="staging">Staging:</span> ${config.staging.baseUrl} | <span class="prod">Prod:</span> ${config.prod.baseUrl}</p>
        <p>Total Pages Tested: <span>${results.length}</span></p>
        <p>Passed: <span class="passed">${passed}</span> | Failed: <span class="failed">${failed}</span> | Errors: <span class="errors">${errors}</span></p>
        <p>Last Run: ${now}</p>
        <a href="${reportPath}" download>Download Report</a>
      </div>
      <p class="criteria">✅ Success Criteria: A similarity score of 95% or higher is considered a pass.</p>
      <table>
        <thead>
          <tr>
            <th>Page</th>
            <th>Similarity</th>
            <th>Status</th>
            <th>Images</th>
          </tr>
        </thead>
        <tbody>
  `;

  results.forEach((result) => {
    const sanitizedPath = result.pagePath.replace(/\//g, "_");
    const stagingBase64 = imageToBase64(
      `screenshots/${deviceName}/staging/${sanitizedPath}.png`
    );
    const prodBase64 = imageToBase64(
      `screenshots/${deviceName}/prod/${sanitizedPath}.png`
    );
    const diffBase64 = imageToBase64(
      `screenshots/${deviceName}/diff/${sanitizedPath}.png`
    );

    let statusClass = "status-error";
    let statusText = "Error";

    if (typeof result.similarityPercentage === "number") {
      if (result.similarityPercentage >= 95) {
        statusClass = "status-pass";
        statusText = "Pass";
      } else {
        statusClass = "status-fail";
        statusText = "Fail";
      }
    }

    htmlContent += `
    <tr>
      <td>
        <a href="${config.staging.baseUrl}${
      result.pagePath
    }" target="_blank" class="staging">Staging</a> | 
        <a href="${config.prod.baseUrl}${
      result.pagePath
    }" target="_blank" class="prod">Prod</a>
      </td>
      <td>${
        typeof result.similarityPercentage === "number"
          ? result.similarityPercentage.toFixed(2) + "%"
          : "Error"
      }</td>
      <td class="${statusClass}">${statusText}</td>
      <td>
        <div class="image-container">
          ${
            stagingBase64
              ? `<div class="image-wrapper">
                   <img src="${stagingBase64}" onclick="openModal('${stagingBase64}')" alt="Staging">
                   <div class="image-label">Staging</div>
                 </div>`
              : "N/A"
          }
          ${
            prodBase64
              ? `<div class="image-wrapper">
                   <img src="${prodBase64}" onclick="openModal('${prodBase64}')" alt="Prod">
                   <div class="image-label">Prod</div>
                 </div>`
              : "N/A"
          }
          ${
            diffBase64
              ? `<div class="image-wrapper">
                   <img src="${diffBase64}" onclick="openModal('${diffBase64}')" alt="Diff">
                   <div class="image-label">Diff</div>
                 </div>`
              : "N/A"
          }
        </div>
      </td>
    </tr>
  `;
  });

  htmlContent += `
        </tbody>
      </table>

      <div id="modal" class="modal">
        <span class="modal-close" onclick="closeModal()">&times;</span>
        <img id="modal-image">
      </div>

      <script>
        function openModal(imageSrc) { 
          document.getElementById("modal-image").src = imageSrc; 
          document.getElementById("modal").style.display = "block"; 
        }
        function closeModal() { 
          document.getElementById("modal").style.display = "none"; 
        }
      </script>

    </body>
    </html>
  `;

  fs.writeFileSync(reportPath, htmlContent);
}

// Main Test Suite
test.describe("Visual Comparison Tests", () => {
  test.setTimeout(7200000);
  test("Compare staging and prod screenshots and generate HTML report", async ({
    browser,
  }) => {
    const results = [];
    const deviceName = "Desktop";

    console.log(chalk.blue("Running tests..."));

    const baseDir = `screenshots/${deviceName}`;
    ["staging", "prod", "diff"].forEach((dir) => {
      if (!fs.existsSync(path.join(baseDir, dir))) {
        fs.mkdirSync(path.join(baseDir, dir), { recursive: true });
      }
    });

    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
    });
    const page = await context.newPage();

    for (const pagePath of config.staging.urls) {
      const stagingUrl = `${config.staging.baseUrl}${pagePath}`;
      const prodUrl = `${config.prod.baseUrl}${pagePath}`;
      const stagingScreenshotPath = path.join(
        baseDir,
        "staging",
        `${pagePath.replace(/\//g, "_")}.png`
      );
      const prodScreenshotPath = path.join(
        baseDir,
        "prod",
        `${pagePath.replace(/\//g, "_")}.png`
      );
      const diffScreenshotPath = path.join(
        baseDir,
        "diff",
        `${pagePath.replace(/\//g, "_")}.png`
      );

      try {
        await captureScreenshot(page, stagingUrl, stagingScreenshotPath);
        await captureScreenshot(page, prodUrl, prodScreenshotPath);

        const similarity = await compareScreenshots(
          stagingScreenshotPath,
          prodScreenshotPath,
          diffScreenshotPath
        );

        results.push({ pagePath, similarityPercentage: similarity });
      } catch (error) {
        results.push({
          pagePath,
          similarityPercentage: "Error",
          error: error.message,
        });
      }
    }

    generateHtmlReport(results, deviceName);
    await context.close();
  });

  test("Verify broken image links automatically on staging pages from config.js", async ({
    page,
  }) => {
    const stagingUrls = config.staging.urls.map(
      (url) => `${config.staging.baseUrl}${url}`
    );

    for (const url of stagingUrls) {
      console.log(chalk.blue(`Navigating to: ${url}`));
      await page.goto(url, { waitUntil: "domcontentloaded" });
      console.log(chalk.green(`Page loaded successfully: ${url}`));

      console.log(chalk.blue("Finding all image elements on the page..."));
      const images = await page.locator("img");
      const imageCount = await images.count();
      console.log(chalk.green(`Found ${imageCount} images on the page.`));

      let brokenImages = 0;

      for (let i = 0; i < imageCount; i++) {
        let imageUrl = await images.nth(i).getAttribute("src");

        if (!imageUrl) {
          console.log(
            chalk.yellow(`Image ${i + 1} does not have a valid src attribute.`)
          );
          brokenImages++;
          continue;
        }

        // Handle relative and protocol-relative URLs
        if (!imageUrl.startsWith("http") && !imageUrl.startsWith("//")) {
          imageUrl = new URL(imageUrl, url).toString();
        } else if (imageUrl.startsWith("//")) {
          imageUrl = `https:${imageUrl}`;
        }

        // Exclude known tracking pixels or problematic URLs
        if (
          imageUrl.includes("bat.bing.com") ||
          imageUrl.includes("tracking")
        ) {
          console.log(
            chalk.yellow(
              `Image ${i + 1} is a tracking pixel or excluded URL: ${imageUrl}`
            )
          );
          continue;
        }

        try {
          console.log(chalk.blue(`Checking image ${i + 1}: ${imageUrl}`));
          const response = await axios.get(imageUrl);

          if (response.status !== 200) {
            console.log(
              chalk.red(
                `Image ${i + 1} failed to load. Status Code: ${response.status}`
              )
            );
            brokenImages++;
          } else {
            console.log(chalk.green(`Image ${i + 1} loaded successfully.`));
          }
        } catch (error) {
          console.log(
            chalk.red(`Image ${i + 1} failed to load. Error: ${error.message}`)
          );
          brokenImages++;
        }
      }

      if (brokenImages > 0) {
        console.log(
          chalk.red(
            `Test failed for ${url}. Found ${brokenImages} broken images on the page.`
          )
        );
      } else {
        console.log(
          chalk.green(
            `Test passed for ${url}. No broken images found on the page.`
          )
        );
      }
    }
  });

  test("Fill out Request Info forms from Header and Inline sequentially and verify confirmation (Staging Only)", async ({
    page,
  }) => {
    try {
      const formPageUrl = "https://live-web-sheridan.pantheonsite.io/";
      console.log(
        chalk.blue(`Navigating to the staging homepage: ${formPageUrl}`)
      );

      // Go to the staging homepage
      await page.goto(formPageUrl, { waitUntil: "domcontentloaded" });
      console.log(chalk.green("Homepage loaded successfully on staging."));

      // ----- FIRST FORM (Header) -----
      console.log(
        chalk.blue("Clicking 'Request Info' button in the header...")
      );
      const requestInfoButtonSelector = "li.request-info-btn a";
      await page.click(requestInfoButtonSelector);
      console.log(chalk.green("'Request Info' button clicked."));

      // Wait for the first form to appear
      const firstFormSelector = "#gform_2";
      await page.waitForSelector(firstFormSelector, {
        state: "visible",
        timeout: 10000,
      });
      console.log(chalk.green("Request Info form (Header) is now visible."));

      // Fill out the first form
      console.log(chalk.blue("Filling out the first form..."));
      await page.selectOption("#input_2_9", "US"); // Country
      await page.selectOption("#input_2_1", "SHERIDAN.CA-B-BINFOSCICBRSEC"); // Program of Interest
      await page.fill("#input_2_2", "John"); // First Name
      await page.fill("#input_2_3", "Doe"); // Last Name
      await page.fill("#input_2_6", "test@ap.com"); // Email
      await page.fill("#input_2_4", "5551234567"); // Phone Number
      await page.fill("#input_2_5", "12345"); // ZIP Code
      await page.selectOption("#input_2_7", "Online"); // How did you hear about us?
      console.log(chalk.green("First form filled successfully."));

      // Click on the "Agree to terms" checkbox
      console.log(chalk.blue("Clicking on the 'Agree to terms' checkbox..."));
      await page.check("#choice_2_10_1");
      console.log(chalk.green("Checkbox clicked."));

      // Submit the first form
      console.log(chalk.blue("Submitting the first form..."));
      await Promise.all([
        page.waitForNavigation({ waitUntil: "domcontentloaded" }),
        page.click("#gform_submit_button_2"),
      ]);
      console.log(chalk.green("First form submitted successfully on staging."));

      // Wait for confirmation message for first form
      const confirmationSelector = "h1.headline1";
      await page.waitForSelector(confirmationSelector, { timeout: 20000 });

      // Verify first form confirmation message
      const confirmationText = await page.textContent(confirmationSelector);
      console.log(
        chalk.blue(
          `First form confirmation message: "${confirmationText.trim()}"`
        )
      );

      expect(confirmationText.trim()).toBe("Great! Now take the next step.");
      console.log(
        chalk.green("First form confirmation message matches expected value.")
      );

      // ----- SECOND FORM (Inline) -----
      // Navigate back to the homepage
      console.log(chalk.blue("Navigating back to the homepage..."));
      await page.goto(formPageUrl, { waitUntil: "domcontentloaded" });
      console.log(chalk.green("Back on the homepage."));

      // Click the second 'Request Info' button
      console.log(chalk.blue("Clicking the second 'Request Info' button..."));
      const secondRequestInfoButtonSelector =
        ".elementor-element-3d3ef31f .form-title";
      await page.click(secondRequestInfoButtonSelector);
      console.log(chalk.green("Second 'Request Info' button clicked."));

      // Wait for the second form to appear
      const secondFormSelector = "#gform_2";
      await page.waitForSelector(secondFormSelector, {
        state: "visible",
        timeout: 10000,
      });
      console.log(chalk.green("Second 'Request Info' form is now visible."));

      // Fill out the second form
      console.log(chalk.blue("Filling out the second form..."));
      await page.selectOption("#input_2_9", "US"); // Country
      await page.selectOption("#input_2_1", "SHERIDAN.CA-B-BCPTRSCI"); // Program of Interest
      await page.fill("#input_2_2", "Jane"); // First Name
      await page.fill("#input_2_3", "Smith"); // Last Name
      await page.fill("#input_2_6", "test@ap.com"); // Email
      await page.fill("#input_2_4", "5559876543"); // Phone Number
      await page.fill("#input_2_5", "67890"); // ZIP Code
      await page.selectOption("#input_2_7", "Online"); // How did you hear about us?
      console.log(chalk.green("Second form filled successfully."));

      // Click on the "Agree to terms" checkbox
      console.log(chalk.blue("Clicking on the 'Agree to terms' checkbox..."));
      await page.check("#choice_2_10_1");
      console.log(chalk.green("Checkbox clicked."));

      // Submit the second form
      console.log(chalk.blue("Submitting the second form..."));
      await Promise.all([
        page.waitForNavigation({ waitUntil: "domcontentloaded" }),
        page.click("#gform_submit_button_2"),
      ]);
      console.log(
        chalk.green("Second form submitted successfully on staging.")
      );

      // Wait for confirmation message for second form
      await page.waitForSelector(confirmationSelector, { timeout: 20000 });

      // Verify second form confirmation message
      const secondConfirmationText = await page.textContent(
        confirmationSelector
      );
      console.log(
        chalk.blue(
          `Second form confirmation message: "${secondConfirmationText.trim()}"`
        )
      );

      expect(secondConfirmationText.trim()).toBe(
        "Great! Now take the next step."
      );
      console.log(
        chalk.green("Second form confirmation message matches expected value.")
      );
    } catch (error) {
      console.error(chalk.red(`Error during test: ${error.message}`));
    }
  });

  test("Click 'Apply Now' (Header, Body x2 & Footer), fill out the form, and verify submission (Staging Only)", async ({
    page,
  }) => {
    try {
      const homePageUrl = "https://live-web-sheridan.pantheonsite.io/";
      const applyPageUrl = "https://live-web-sheridan.pantheonsite.io/apply/";
      const confirmationSelector = "h1.headline2"; // Confirmation message

      const applyNowSelectors = {
        header: "li.apply-now-btn a.elementor-item",
        body1: "a.button.primary.apply-now.button-border",
        body2: "a.button.primary.programpage-hide",
        footer: "a.button[aria-label='apply now from sticky footer']",
      };

      const formSelectors = {
        form: "#gform_1",
        country: "#input_1_13",
        program: "#input_1_1",
        firstName: "#input_1_2",
        lastName: "#input_1_3",
        email: "#input_1_4",
        phone: "#input_1_5",
        zipCode: "#input_1_6",
        howDidYouHear: "#input_1_7",
        agreeCheckbox: "#choice_1_15_1",
        submitButton: "#gform_submit_button_1",
      };

      const testData = {
        country: "US",
        program: "SHERIDAN.CA-B-BINFOSCICBRSEC",
        firstName: "John",
        lastName: "Doe",
        email: "test@ap.com",
        phone: "5551234567",
        zipCode: "12345",
        howDidYouHear: "Email",
      };

      async function fillAndSubmitForm() {
        console.log(chalk.blue("Filling out the Apply Now form..."));
        await page.selectOption(formSelectors.country, testData.country);
        await page.selectOption(formSelectors.program, testData.program);
        await page.fill(formSelectors.firstName, testData.firstName);
        await page.fill(formSelectors.lastName, testData.lastName);
        await page.fill(formSelectors.email, testData.email);
        await page.fill(formSelectors.phone, testData.phone);
        await page.fill(formSelectors.zipCode, testData.zipCode);
        await page.selectOption(
          formSelectors.howDidYouHear,
          testData.howDidYouHear
        );
        console.log(chalk.green("Form fields filled successfully."));

        console.log(chalk.blue("Clicking on the 'Agree to terms' checkbox..."));
        await page.check(formSelectors.agreeCheckbox);
        console.log(chalk.green("Checkbox clicked."));

        console.log(chalk.blue("Submitting the Apply Now form..."));
        await page.click(formSelectors.submitButton);

        console.log(chalk.blue("Waiting for confirmation message..."));
        await page.waitForLoadState("networkidle"); // Ensures network is idle
        await page.waitForSelector(confirmationSelector, { timeout: 30000 });

        const confirmationText = await page.textContent(confirmationSelector);
        console.log(
          chalk.blue(`Confirmation message found: "${confirmationText.trim()}"`)
        );

        expect(confirmationText.trim()).toBe("Great! Now, take the next step.");
        console.log(
          chalk.green("Confirmation message matches expected value.")
        );
      }

      async function clickApplyNowButton(buttonSelector, buttonLocation) {
        console.log(
          chalk.blue(
            `Clicking on the 'Apply Now' button in the ${buttonLocation}...`
          )
        );
        await page.click(buttonSelector);

        console.log(chalk.blue(`Waiting for navigation to: ${applyPageUrl}`));
        await page.waitForURL(applyPageUrl, { timeout: 15000 });
        console.log(
          chalk.green(
            `Navigated to the Apply Now form page from the ${buttonLocation}.`
          )
        );

        console.log(
          chalk.blue("Waiting for the Apply Now form to be visible...")
        );
        await page.waitForSelector(formSelectors.form, {
          state: "visible",
          timeout: 10000,
        });
        console.log(chalk.green("Apply Now form is visible."));
      }

      // Step 1: Navigate to Homepage
      console.log(chalk.blue(`Navigating to the home page: ${homePageUrl}`));
      await page.goto(homePageUrl, { waitUntil: "domcontentloaded" });
      console.log(chalk.green("Homepage loaded successfully."));

      // Step 2: Click "Apply Now" from the Header and Submit Form
      await clickApplyNowButton(applyNowSelectors.header, "header");
      await fillAndSubmitForm();

      // Step 3: Return to Homepage
      console.log(
        chalk.blue("Returning to the homepage for the next Apply Now test...")
      );
      await page.goto(homePageUrl, { waitUntil: "domcontentloaded" });
      console.log(chalk.green("Homepage reloaded successfully."));

      // Step 4: Click "Apply Now" from the First Body Section and Submit Form
      await clickApplyNowButton(applyNowSelectors.body1, "body (first)");
      await fillAndSubmitForm();

      // Step 5: Return to Homepage
      console.log(
        chalk.blue(
          "Returning to the homepage for the additional Apply Now test..."
        )
      );
      await page.goto(homePageUrl, { waitUntil: "domcontentloaded" });
      console.log(chalk.green("Homepage reloaded successfully."));

      // Step 6: Click "Apply Now" from the Second Body Section and Submit Form
      await clickApplyNowButton(applyNowSelectors.body2, "body (second)");
      await fillAndSubmitForm();

      // Step 7: Return to Homepage
      console.log(
        chalk.blue("Returning to the homepage for the footer Apply Now test...")
      );
      await page.goto(homePageUrl, { waitUntil: "domcontentloaded" });
      console.log(chalk.green("Homepage reloaded successfully."));

      // Step 8: Click "Apply Now" from the Footer and Submit Form
      await clickApplyNowButton(applyNowSelectors.footer, "footer");
      await fillAndSubmitForm();
    } catch (error) {
      console.error(chalk.red(`Test failed: ${error.message}`));
    }
  });

  test("Verify Online Programs and Getting Started Menus - Sheridan", async ({
    page,
  }) => {
    const verifyMenu = async (
      menuName,
      menuSelector,
      submenuSelector,
      linksSelector
    ) => {
      console.log(chalk.blue(`Locating the '${menuName}' menu...`));

      // Wait for the menu element to be attached to the DOM
      const menuElement = await page.locator(menuSelector).first();
      await menuElement.waitFor({ state: "attached", timeout: 10000 });

      console.log(chalk.blue(`Ensuring '${menuName}' menu is visible...`));
      await menuElement.scrollIntoViewIfNeeded();

      // Attempt hover
      console.log(chalk.blue(`Hovering over the '${menuName}' menu...`));
      await menuElement.hover();
      await page.waitForTimeout(500); // Short delay for rendering

      // Check if the submenu is visible
      const submenus = await page.locator(submenuSelector);
      const isMenuVisible = await submenus.first().isVisible();

      if (!isMenuVisible) {
        console.log(
          chalk.yellow(
            `Hover did not reveal the '${menuName}' submenu, attempting a click...`
          )
        );
        await menuElement.click({ force: true });
      }

      // Ensure submenu is visible after hover/click
      await page.waitForSelector(submenuSelector, {
        state: "visible",
        timeout: 10000,
      });

      const submenuCount = await submenus.count();
      if (submenuCount === 0) {
        throw new Error(`No submenus found for '${menuName}' menu.`);
      }
      console.log(
        chalk.green(`Found ${submenuCount} submenus in the '${menuName}' menu.`)
      );

      // Verify links
      const links = await page.locator(linksSelector);
      const linkCount = await links.count();
      if (linkCount === 0) {
        throw new Error(`No links found in the '${menuName}' menu.`);
      }
      console.log(
        chalk.green(`Found ${linkCount} links in the '${menuName}' menu.`)
      );

      let invalidLinks = 0;
      for (let i = 0; i < linkCount; i++) {
        const linkText = await links.nth(i).textContent();
        const linkHref = await links.nth(i).getAttribute("href");
        console.log(
          chalk.blue(
            `Checking link ${i + 1} in '${menuName}' menu: ${linkText}`
          )
        );

        if (!linkHref || linkHref.trim() === "") {
          console.log(
            chalk.yellow(
              `Warning: Link '${linkText}' in '${menuName}' menu has no valid href.`
            )
          );
          invalidLinks++;
        } else {
          console.log(chalk.green(`Valid link: '${linkText}' -> ${linkHref}`));
        }
      }

      console.log(
        chalk.green(
          `Completed checks for '${menuName}'. Invalid links: ${invalidLinks}`
        )
      );

      if (invalidLinks > 0) {
        console.log(
          chalk.yellow(
            `Test finished with ${invalidLinks} warnings for '${menuName}'.`
          )
        );
      } else {
        console.log(chalk.green(`All links in '${menuName}' are valid.`));
      }
    };

    const homePageUrl = "https://live-web-sheridan.pantheonsite.io/";
    console.log(chalk.blue(`Navigating to the YSU homepage: ${homePageUrl}`));
    await page.goto(homePageUrl, { waitUntil: "domcontentloaded" });
    console.log(chalk.green("Homepage loaded successfully."));

    // Verify the "Online Programs" menu
    await verifyMenu(
      "Online Programs",
      "#mega-menu-item-148 > a.mega-menu-link",
      "#mega-menu-item-148 ul.mega-sub-menu",
      "#mega-menu-item-148 ul.mega-sub-menu a.mega-menu-link"
    );

    // Verify the "Getting Started" menu
    await verifyMenu(
      "Getting Started",
      "#mega-menu-item-153 > a.mega-menu-link",
      "#mega-menu-item-153 ul.mega-sub-menu",
      "#mega-menu-item-153 ul.mega-sub-menu a.mega-menu-link"
    );
  });
});
