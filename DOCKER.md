# Docker Setup for Digital Photo Frame

This document explains how to run the Digital Photo Frame application using Docker.

## Quick Start

### Using Docker Compose (Recommended)

1. **Copy environment configuration:**
   ```bash
   cp .env.example .env
   ```

2. **Edit the .env file with your settings:**
   ```bash
   # Essential settings - change these for security
   SESSION_SECRET=your-secure-session-secret-here
   ADMIN_PASSWORD=your-secure-admin-password
   
   # Optional: Change port (default is 3000)
   HOST_PORT=8080  # Access app on http://localhost:8080
   ```

3. **Start the application:**
   ```bash
   docker compose up -d
   ```

4. **Access the application:**
   - Open http://localhost:3000 in your browser (or your custom HOST_PORT)
   - Admin password: your ADMIN_PASSWORD. Without one, the server makes one up and prints it: `docker compose logs photo-frame | grep password`

5. **Stop the application:**
   ```bash
   docker compose down
   ```

### Using Docker Build (Manual)

1. **Build the image:**
   ```bash
   docker build -t digital-photo-frame .
   ```

2. **Run the container:**
   ```bash
   docker run -d \
     --name photo-frame \
     -p 3000:3000 \
     -e SESSION_SECRET=your-secure-session-secret \
     -v photo-uploads:/app/uploads \
     -v photo-data:/app/data \
     digital-photo-frame
   ```

## Configuration

### Quick Configuration Examples

**Change Port:**
```bash
# Use port 8080 instead of 3000
echo "HOST_PORT=8080" >> .env
docker compose up -d
# Access at http://localhost:8080
```

**Secure Admin Password:**
```bash
# Set custom admin password
echo "ADMIN_PASSWORD=MySecurePassword123!" >> .env
docker compose up -d
```

**Multiple Options:**
```bash
# .env file example
HOST_PORT=8080
ADMIN_PASSWORD=SecurePass123!
SESSION_SECRET=$(openssl rand -base64 32)
```

### Environment Variables

| Variable | Description | Required | Default |
|----------|-------------|----------|---------|
| `HOST_PORT` | External port on host machine | No | 3000 |
| `CONTAINER_PORT` | Internal container port | No | 3000 |
| `NODE_ENV` | Node environment | No | production |
| `SESSION_SECRET` | Session encryption key | **Yes** | - |
| `ADMIN_PASSWORD` | Admin login password | **Recommended** | made up at first start, printed in the logs |
| `TRUST_PROXY` | Which `X-Forwarded-*` headers to believe. `false` if nothing sits in front of the server | No | 1 (one reverse proxy) |
| `GOOGLE_CLIENT_ID` | Google Photos API client ID | No | - |
| `GOOGLE_CLIENT_SECRET` | Google Photos API secret | No | - |
| `GOOGLE_REDIRECT_URI` | Google OAuth redirect URI | No | - |

### Volumes

The Docker setup creates persistent volumes for:

- **photo-uploads**: Stores uploaded images (`/app/uploads`)
- **photo-data**: Stores application data like access accounts (`/app/data`)
- **photo-logs**: Stores application logs (`/app/logs`)

### Password Security

The application supports both plain text and bcrypt hashed passwords:

**Plain Text (Development):**
```bash
ADMIN_PASSWORD=MyPassword123
```

**Bcrypt Hashed (Production):**
```bash
# Generate bcrypt hash (example using Node.js)
node -e "const bcrypt=require('bcryptjs'); console.log(bcrypt.hashSync('MyPassword123', 10))"
# Copy the output to .env
ADMIN_PASSWORD=$2b$10$xyz...  # Your bcrypt hash
```

⚠️ **Security:** there is no default password. Without `ADMIN_PASSWORD` (or with the old default `admin123`), the server makes up a password, keeps it in the data volume and prints it in the logs at every start. Wrong passwords are locked out after 5 tries from one address, or 20 from everyone, for 15 minutes, doubling each time.

## Health Check

The container includes a health check that verifies the application is responding:

```bash
# Check container health
docker compose ps

# Test health endpoint directly
curl http://localhost:3000/api/health
```

## Troubleshooting

### Container won't start
- Check if port 3000 is already in use: `lsof -i :3000`
- Verify environment variables are set correctly
- Check container logs: `docker compose logs photo-frame`

### Images not persisting
- Ensure volumes are mounted correctly
- Check volume permissions: `docker compose exec photo-frame ls -la /app/uploads`

### Google Photos integration not working
- Verify Google OAuth credentials in `.env`
- Ensure redirect URI matches your domain
- Check container logs for authentication errors

## Development

For development with live reloading, you can mount the source code:

```bash
# Add to docker-compose.yml under volumes:
- ./server:/app
- /app/node_modules  # Prevent overwriting container's node_modules
```

## Production Deployment

For production deployment:

1. **Set secure environment variables:**
   - Use a strong `SESSION_SECRET` (32+ characters)
   - Set `NODE_ENV=production`

2. **Use a reverse proxy:**
   - Consider using nginx or traefik in front of the container
   - Enable HTTPS for secure sessions

3. **Backup volumes:**
   - Regularly backup the `photo-uploads` and `photo-data` volumes

4. **Monitor resources:**
   - The Sharp image processing library can be memory-intensive
   - Monitor container resource usage under load