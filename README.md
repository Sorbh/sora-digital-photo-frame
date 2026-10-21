<div align="center">
<img width="1022" height="256" alt="sora_github_banner" src="https://github.com/user-attachments/assets/dc1dd451-e360-4245-a062-32e667db05bb" />
   
### Open Source Digital Photo Frame

[Website](https://sora-frame.vercel.app/)  |  [Quick Start](https://docs-sora-frame.vercel.app/quickstart/)  |  [Docs](https://docs-sora-frame.vercel.app/)  |  [API References](https://docs-sora-frame.vercel.app/api-reference/introduction)

</div>


# SORA Frame
Turn any device with a web browser into a smart, open-source digital photo frame. Manage your photos remotely and enjoy a beautiful, full-screen slideshow on any tablet, laptop, or smart TV.

<img width="1885" alt="slideshow-preview" src="https://github.com/user-attachments/assets/4740a698-08f5-4b7c-bb2e-603ca0ebf012" />

## Features

- **Run Anywhere**: Works on any device with a modern web browser.
- **Beautiful Slideshow**: A clean, full-screen photo display with smooth fade transitions, auto-advance, and random image display.
- **Remote Management**: A Finder-like admin panel to upload, organize, and delete photos and folders from any device on your network. Supports drag-and-drop.
- **Targeted Slideshows**: An interactive folder selector to display photos from specific folders, including nested ones. Your last selected folder is even remembered across sessions.
- **Modern UI**: Clean and responsive interface following Material Design 3 principles.
- **Keyboard-Friendly**: Full keyboard navigation and shortcuts for both the slideshow and admin panel.
- **Always On**: Wake Lock support prevents the display device from sleeping during a slideshow.
- **Responsive Design**: Optimized for all screen sizes and orientations.

## Quick Start

Requires Node.js 18+.

```bash
git clone https://github.com/sorbh/digital-photo-frame.git
cd digital-photo-frame
npm install        # installs the server and creates server/.env
npm start
```

Set `ADMIN_PASSWORD` in `server/.env`, then open `http://localhost:3000` for the slideshow and `http://localhost:3000/admin` to manage photos.

Prefer Docker? `ADMIN_PASSWORD=yourpassword docker compose up -d` - see [DOCKER.md](DOCKER.md).

## How It Works

### Managing Photos

Access the admin panel by navigating to `http://your-server-ip:3000/admin` and logging in with your password.

From there, you can:
- **Upload Photos**: Drag and drop images directly into the current folder or use the upload button.
- **Organize**: Create and delete nested folders to organize your library.
- **Supported formats**: JPEG, PNG, WebP, GIF.

### Viewing the Slideshow

On the slideshow screen, you can:
- **Filter by Folder**: Click the folder icon to open the folder selector. You can view all photos or select a specific folder, including nested ones. The slideshow updates instantly.
- **Control Playback**: Use keyboard shortcuts to play/pause, advance to the next image, and more.

#### Slideshow Keyboard Shortcuts
- `Space` or `K`: Play/pause slideshow
- `Right Arrow` or `N`: Next image
- `F`: Toggle fullscreen mode
- `I`: Show/hide image information

## License

This project is licensed under the ISC License - see the [LICENSE](LICENSE) file for details.

## Support

- **Issues**: [GitHub Issues](https://github.com/sorbh/digital-photo-frame/issues)
- **Documentation**: See the `/documentation` directory for technical specifications
- **Discussions**: [GitHub Discussions](https://github.com/sorbh/digital-photo-frame/discussions)

---

**Transform any device into a beautiful digital photo frame!** 📸✨

---

<p align="center">
Built with ❤️ by Claude Code - Monitored & Prompted by Saurabh K. Sharma
</p>
