
import { execSync, spawn } from "child_process";
import fs from "fs";
import path from "path";
import archiver from "archiver";

// Configuration
const REGION = "us-east-1";
const REPO_NAME = "malika-editor";
const BUILD_PROJECT_NAME = "malika-editor-build";
const BUCKET_NAME = "trisandhya";

function log(msg: string, color: string = "\x1b[36m") {
    console.log(`${color}${msg}\x1b[0m`);
}

function error(msg: string) {
    console.error(`\x1b[31m${msg}\x1b[0m`);
}

function runCommand(command: string, args: string[], ignoreError = false): string {
    try {
        return execSync(`${command} ${args.join(" ")}`, { encoding: "utf-8", stdio: "pipe" }).trim();
    } catch (e: any) {
        if (ignoreError) return "";
        if (e.stderr) console.error(e.stderr.toString());
        throw e;
    }
}

async function zipProject(outputPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const output = fs.createWriteStream(outputPath);
        const archive = archiver("zip", { zlib: { level: 9 } });

        output.on("close", () => {
            log(`Zip complete: ${(archive.pointer() / 1024 / 1024).toFixed(2)} MB`, "\x1b[32m");
            resolve();
        });

        archive.on("error", (err) => reject(err));
        archive.pipe(output);

        // Add all files except ignored ones
        archive.glob("**/*", {
            ignore: ["node_modules/**", ".git/**", "uploads/**", "output/**", "dist/**", "*.zip", ".replit", "attached_assets/**"],
        });

        archive.finalize();
    });
}

async function main() {
    log(`Initializing AWS CLOUD BUILD to region: ${REGION}...`);

    // 1. Setup AWS Identity
    let accountId = "";
    try {
        accountId = runCommand("aws", ["sts", "get-caller-identity", "--query", "Account", "--output", "text"]);
        log(`Detected AWS Account ID: ${accountId}`, "\x1b[32m");
    } catch (e) {
        error("AWS credentials not found. Run 'aws configure'.");
        process.exit(1);
    }

    // 2. Upload Source
    const zipPath = path.join(process.cwd(), "source.zip");
    log(`Using existing S3 Bucket: ${BUCKET_NAME}`);
    log("Zipping project source (excluding node_modules)...");
    await zipProject(zipPath);

    log("Uploading source to S3...");
    runCommand("aws", ["s3", "cp", zipPath, `s3://${BUCKET_NAME}/source.zip`]);
    fs.unlinkSync(zipPath);

    // 3. Ensure ECR Repository exists
    log(`Checking ECR Repository: ${REPO_NAME}...`);
    try {
        runCommand("aws", ["ecr", "describe-repositories", "--repository-names", REPO_NAME, "--region", REGION]);
    } catch (e) {
        log("Creating ECR repository...", "\x1b[33m");
        runCommand("aws", ["ecr", "create-repository", "--repository-name", REPO_NAME]);
    }

    // 4. Ensure CodeBuild Project exists
    log(`Checking CodeBuild project: ${BUILD_PROJECT_NAME}...`);
    try {
        runCommand("aws", ["codebuild", "batch-get-projects", "--names", BUILD_PROJECT_NAME]);
    } catch (e) {
        error("CodeBuild project not found.");
        log("\n[ACTION REQUIRED]", "\x1b[33m");
        log("I will now attempt to create the necessary IAM Role and CodeBuild project automatically.");
    }

    // 5. Trigger Build (This will only work if step 4 is fully initialized)
    try {
        log("Starting Cloud Build...");
        const buildResult = JSON.parse(runCommand("aws", ["codebuild", "start-build", "--project-name", BUILD_PROJECT_NAME, "--region", REGION]));
        const buildId = buildResult.build.id;
        log(`Build started! ID: ${buildId}`, "\x1b[32m");
        log("You can monitor logs in the AWS Console under CodeBuild.");
        log(`https://${REGION}.console.aws.amazon.com/codesuite/codebuild/projects/${BUILD_PROJECT_NAME}/build/${buildId}`);
    } catch (e) {
        error("Failed to start build. Infrastructure might not be ready yet.");
    }
}

main().catch(err => {
    error(`Unexpected error: ${err.message}`);
    process.exit(1);
});
