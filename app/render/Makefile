.PHONY: local-test local-deploy dev-deploy prod-deploy

# Cloud Run configuration
PROJECT_ID := tissuelab-2025
REGION := us-central1

# Local development test (without Docker)
local-test:
	@echo "Starting local development environment..."
	pnpm install
	pnpm dev

# Local Docker test
local-deploy:
	@echo "Building and running Docker container..."
	docker build -t tissuelab-app \
		--build-arg ENV_NAME=development \
		.
	docker run -p 8080:8080 tissuelab-app

# Deploy to development environment
dev-deploy:
	@echo "Deploying to development environment..."
	gcloud config set project $(PROJECT_ID)
	@echo "Using .env.development for development deployment..."
	@if exist .env.production ren .env.production .env
	@if exist .env.development copy .env.development .env.production
	@echo "Switching to deploy next.config.js..."
	@if exist deploy.next.config.js copy deploy.next.config.js next.config.js
	@echo "Deploying from source to Cloud Run (dev)..."
	gcloud run deploy tissuelab-app-dev \
		--source . \
		--platform managed \
		--region $(REGION) \
		--allow-unauthenticated \
		--timeout 300 \
		--port 8080 \
		--set-env-vars ENV=dev,BRANCH_NAME=develop
	@echo "Restoring original files..."
	@if exist .env del /Q .env.production
	@if exist .env ren .env .env.production
	@if exist local.next.config.js copy local.next.config.js next.config.js

# Deploy to production environment
prod-deploy:
	@echo "Deploying to production environment..."
	gcloud config set project $(PROJECT_ID)
	@echo "Switching to deploy next.config.js..."
	@if exist deploy.next.config.js copy deploy.next.config.js next.config.js
	@echo "Deploying from source to Cloud Run (prod)..."
	gcloud run deploy tissuelab-app-prod \
		--source . \
		--platform managed \
		--region $(REGION) \
		--allow-unauthenticated \
		--timeout 300 \
		--port 8080 \
		--set-env-vars ENV=prod,BRANCH_NAME=main
	@echo "Restoring local next.config.js..."
	@if exist local.next.config.js copy local.next.config.js next.config.js
