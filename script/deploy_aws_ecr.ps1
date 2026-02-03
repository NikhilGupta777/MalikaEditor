
# Deploy to AWS ECR Script
# Automates the process of building and pushing the application to AWS ECR

$ErrorActionPreference = "Stop"

# Configuration
$REGION = "us-east-1"
$REPO_NAME = "malika-editor"

Write-Host "Initializing AWS Deployment..." -ForegroundColor Cyan

# 1. Get AWS Account ID
try {
    $ACCOUNT_ID = aws sts get-caller-identity --query Account --output text
    if (-not $ACCOUNT_ID) { throw "Could not retrieve AWS Account ID" }
    Write-Host "Detected AWS Account ID: $ACCOUNT_ID" -ForegroundColor Green
} catch {
    Write-Error "Failed to get AWS identity. Please run 'aws configure' first."
    exit 1
}

# 2. Check/Create ECR Repository
$REPO_URI = "$ACCOUNT_ID.dkr.ecr.$REGION.amazonaws.com/$REPO_NAME"
Write-Host "Checking ECR Repository: $REPO_NAME..." -ForegroundColor Cyan

# Run command and check exit code explicitly instead of converting stderr to exception
aws ecr describe-repositories --repository-names $REPO_NAME --region $REGION *>$null
if ($LASTEXITCODE -ne 0) {
    Write-Host "Repository '$REPO_NAME' not found. Creating..." -ForegroundColor Yellow
    aws ecr create-repository --repository-name $REPO_NAME --region $REGION | Out-Null
    if ($LASTEXITCODE -eq 0) {
        Write-Host "Repository created successfully." -ForegroundColor Green
    } else {
        Write-Error "Failed to create repository."
        exit 1
    }
} else {
    Write-Host "Repository exists." -ForegroundColor Green
}

# 3. Login to ECR
Write-Host "Logging in to AWS ECR..." -ForegroundColor Cyan
try {
    aws ecr get-login-password --region $REGION | docker login --username AWS --password-stdin "$ACCOUNT_ID.dkr.ecr.$REGION.amazonaws.com"
} catch {
    Write-Error "Failed to login to ECR. Is Docker running?"
    exit 1
}

# 4. Build Docker Image
Write-Host "Building Docker Image (Targeting Linux/AMD64)..." -ForegroundColor Cyan
# Using --platform linux/amd64 to ensure compatibility with AWS App Runner/Lightsail even if built on Windows/M1 Mac
docker build --platform linux/amd64 -t "$REPO_URI`:latest" .
if ($LASTEXITCODE -ne 0) {
    Write-Error "Docker build failed."
    exit 1
}

# 5. Push to ECR
Write-Host "Pushing image to ECR ($REPO_URI)..." -ForegroundColor Cyan
docker push "$REPO_URI`:latest"
if ($LASTEXITCODE -ne 0) {
    Write-Error "Docker push failed."
    exit 1
}

Write-Host "`n--------------------------------------------------"
Write-Host "DEPLOYMENT SUCCESSFUL!" -ForegroundColor Green
Write-Host "--------------------------------------------------"
Write-Host "Your image URI is:"
Write-Host "$REPO_URI`:latest" -ForegroundColor Yellow
Write-Host "`nNext Steps for App Runner / Lightsail:"
Write-Host "1. Create a Service"
Write-Host "2. Choose 'Container Image'"
Write-Host "3. Paste the URI above"
Write-Host "4. Add Environment Variables (DATABASE_URL, S3_BUCKET_NAME, etc.)"
Write-Host "--------------------------------------------------"
