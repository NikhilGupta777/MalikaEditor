# AWS Deployment Guide

This guide details how to deploy your **Node.js + FFmpeg + PostgreSQL** application on AWS. Because your application depends on `ffmpeg`, you must use a container-based deployment service.

> **Important**: Your application writes uploaded files to disk by default. In containerized environments (Lightsail/App Runner), local changes are lost on restart. You **must** configure **AWS S3** for persistent storage.

## Option 1: AWS Lightsail Containers (Recommended)
**Best for**: Simplicity, fixed monthly pricing ($7+), and bundled database options.

### 1. Database Setup
1.  Navigate to **Lightsail Console > Databases**.
2.  Click **Create database**.
3.  Select **PostgreSQL** (latest version).
4.  Choose your credentials (username/password) and plan.
5.  **Save your connection details**. You will need them for the `DATABASE_URL`.
    *   Format: `postgres://user:password@endpoint:5432/dbname`

### 2. Storage Setup (S3)
1.  Navigate to **S3 Console**.
2.  Create a bucket (e.g., `malika-app-uploads`).
3.  **Uncheck** "Block all public access" if you want the app to generate public links, OR keep it blocked and rely on pre-signed URLs (recommended).
4.  Go to **IAM Console** and create a user with **Programmatic Access**.
5.  Attach the `AmazonS3FullAccess` policy (or a custom policy scoped to your bucket).
6.  Save the **Access Key ID** and **Secret Access Key**.

### 3. Container Deployment
1.  **Install Lightsail Plugin** (if deploying from CLI) or use the Console.
2.  Navigate to **Lightsail Console > Containers**.
3.  Click **Create container service**.
4.  **Set up the Service**:
    *   Select size (e.g., Micro or Small).
    *   Skip the image step for now (create the service first).
5.  **Create a New Deployment** (once service is ready):
    *   **Image**: `docker.io/library/node:20` (as a placeholder) OR push your own image via CLI.
    *   **Pushing your image**:
        ```bash
        # Build locally
        docker build -t malika-app .
        
        # Push to Lightsail (requires AWS CLI + Lightsail plugin)
        aws lightsail push-container-image --service-name my-service --label v1 --image malika-app
        ```
    *   **Environment Variables**:
        *   `NODE_ENV`: `production`
        *   `PORT`: `5000`
        *   `DATABASE_URL`: *(Your Postgres connection string)*
        *   `FILE_STORAGE_TYPE`: `s3`
        *   `S3_BUCKET_NAME`: *(Your bucket name)*
        *   `S3_REGION`: `us-east-1` (or your region)
        *   `AWS_ACCESS_KEY_ID`: *(Your IAM Key)*
        *   `AWS_SECRET_ACCESS_KEY`: *(Your IAM Secret)*
    *   **Port**: `5000` (HTTP).
6.  **Public Endpoint**: Check the box to make the container public on port 5000.

---

## Option 2: AWS App Runner
**Best for**: Auto-scaling, managed CI/CD from ECR.

1.  **Push to ECR**:
    ```bash
    aws ecr create-repository --repository-name malika-app
    # Login, Build, Tag, Push (use commands from ECR "View push commands" button)
    ```
2.  **Create Service**:
    *   Go to **App Runner**.
    *   Source: **Amazon ECR**.
    *   Deployment settings: **Automatic** (deploys on new push).
3.  **Configure**:
    *   Runtime: **Code** or **Image** (Choose Image).
    *   Port: `5000`.
    *   **Environment Variables**: Same as Lightsail (`DATABASE_URL`, `FILE_STORAGE_TYPE`, `S3_...`).
4.  **Database**: Use **Amazon RDS** or a Lightsail DB. Ensure the Security Group allows traffic from App Runner.

---

## Troubleshooting
*   **Database Connection**: If the app crashes on startup, check the specific `DATABASE_URL`. Ensure the database is accessible (publicly or via VPC peering).
*   **Migrations**: Run `npm run db:migrate` locally pointing to the remote DB connection string to set up the schema before deploying.
*   **Logs**: Check Lightsail/App Runner logs to see startup errors (e.g., missing env vars).
