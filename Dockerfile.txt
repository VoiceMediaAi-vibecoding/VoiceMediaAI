# Use official Deno image
FROM denoland/deno:1.40.0

# Set working directory
WORKDIR /app

# Copy application code
COPY main.ts .

# Cache dependencies
RUN deno cache main.ts

# Expose port (Railway sets PORT env var)
EXPOSE 8080

# Run the application
CMD ["run", "--allow-net", "--allow-env", "--allow-read", "main.ts"]
