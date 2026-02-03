
import { execSync, spawn } from "child_process";
import fs from "fs";
import path from "path";

// Configuration
const REGION = "us-east-1";
const REPO_NAME = "malika-editor";

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
        if (ignoreError) {
            return "";
        }
        // Forward stderr if available
        if (e.stderr) {
            console.error(e.stderr.toString());
        }
        throw e;
    }
}

async function main() {
    log(`Initializing AWS Deployment to region: ${REGION}...`);

    // 1. Get AWS Account ID
    let accountId = "";
    try {
        accountId = runCommand("aws", ["sts", "get-caller-identity", "--query", "Account", "--output", "text"]);
        log(`Detected AWS Account ID: ${accountId}`, "\x1b[32m");
    } catch (e) {
        error("Failed to get AWS identity. Please run 'aws configure' first.");
        process.exit(1);
    }

    // 2. Check/Create ECR Repository
    const repoUri = `${accountId}.dkr.ecr.${REGION}.amazonaws.com/${REPO_NAME}`;
    log(`Checking ECR Repository: ${REPO_NAME}...`);

    try {
        runCommand("aws", ["ecr", "describe-repositories", "--repository-names", REPO_NAME, "--region", REGION]);
        log("Repository exists.", "\x1b[32m");
    } catch (e) {
        log(`Repository '${REPO_NAME}' not found. Creating...`, "\x1b[33m");
        try {
            runCommand("aws", ["ecr", "create-repository", "--repository-name", REPO_NAME, "--region", REGION]);
            log("Repository created successfully.", "\x1b[32m");
        } catch (createErr) {
            error("Failed to create repository.");
            process.exit(1);
        }
    }

    // 3. Login to ECR
    log("Logging in to AWS ECR...");
    try {
        // Get login password
        const password = runCommand("aws", ["ecr", "get-login-password", "--region", REGION]);

        // Login to docker
        // We use spawn specifically here to pipe stdin securely
        const dockerLogin = spawn("docker", ["login", "--username", "AWS", "--password-stdin", `${accountId}.dkr.ecr.${REGION}.amazonaws.com`]);

        dockerLogin.stdin.write(password);
        dockerLogin.stdin.end();

        await new Promise<void>((resolve, reject) => {
            dockerLogin.on('close', (code) => {
                if (code === 0) {
                    log("Logged in to ECR successfully.", "\x1b[32m");
                    resolve();
                } else {
                    reject(new Error("Docker login failed"));
                }
            });
            dockerLogin.stdout.on('data', (d) => console.log(d.toString()));
            dockerLogin.stderr.on('data', (d) => console.error(d.toString()));
        });

    } catch (e) {
        error("Failed to login to ECR.");
        process.exit(1);
    }

    // 4. Build Docker Image
    log("Building Docker Image (Targeting Linux/AMD64)...");
    try {
        // Run docker build connecting stdio to parent to show progress
        const buildProc = spawn("docker", ["build", "--platform", "linux/amd64", "-t", `${repoUri}:latest`, "."], { stdio: "inherit", shell: true });

        await new Promise<void>((resolve, reject) => {
            buildProc.on('close', (code) => {
                if (code === 0) resolve();
                else reject(new Error("Build failed"));
            });
        });
    } catch (e) {
        error("Docker build failed.");
        process.exit(1);
    }

    // 5. Push to ECR
    log(`Pushing image to ECR (${repoUri})...`);
    try {
        const pushProc = spawn("docker", ["push", `${repoUri}:latest`], { stdio: "inherit", shell: true });

        await new Promise<void>((resolve, reject) => {
            pushProc.on('close', (code) => {
                if (code === 0) resolve();
                else reject(new Error("Push failed"));
            });
        });
    } catch (e) {
        error("Docker push failed.");
        process.exit(1);
    }

    console.log("\n--------------------------------------------------");
    log("DEPLOYMENT SUCCESSFUL!", "\x1b[32m");
    console.log("--------------------------------------------------");
    log("Your image URI is:", "\x1b[33m");
    console.log(`${repoUri}:latest`);
    console.log("\nNext Steps for App Runner / Lightsail:");
    console.log("1. Use the Image URI above.");
    console.log("2. Set environment variables (DATABASE_URL, S3_BUCKET_NAME, etc.)");
    console.log("--------------------------------------------------");
}

main().catch(err => {
    error(`Unexpected error: ${err.message}`);
    process.exit(1);
});
