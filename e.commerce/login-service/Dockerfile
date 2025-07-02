# Use Nginx to serve static files
FROM nginx:alpine

# Remove default Nginx static files
RUN rm -rf /usr/share/nginx/html/*

# Copy our static files
COPY . /usr/share/nginx/html

EXPOSE 80

