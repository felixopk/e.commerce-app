
# Use official Node.js LTS image
FROM node:20-alpine

# Set working directory
WORKDIR /app

# Copy only package files first (for caching)
COPY package*.json ./

# Install dependencies
RUN npm install --production

# Copy the rest of the application
COPY . .

# Expose the app port
EXPOSE 3001

# Start the app
CMD ["npm", "index.js"]

