using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Threading;
using System.Windows.Forms;
using System.Web.Script.Serialization;

internal static class Launcher
{
    private const int Port = 11451;
    private static readonly string Root = AppDomain.CurrentDomain.BaseDirectory;
    private static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 80 * 1024 * 1024, RecursionLimit = 100 };

    [STAThread]
    private static void Main()
    {
        ConfigureTls();
        TcpListener listener = new TcpListener(IPAddress.Loopback, Port);
        try { listener.Start(); }
        catch (SocketException)
        {
            MessageBox.Show("漫译服务无法启动：11451 端口已被占用。\n如果漫译已经运行，可直接访问 http://127.0.0.1:11451。", "漫译", MessageBoxButtons.OK, MessageBoxIcon.Information);
            return;
        }

        Thread server = new Thread(delegate() { AcceptLoop(listener); });
        server.IsBackground = true;
        server.Start();
        string address = "http://127.0.0.1:" + Port + "/";
        try { Process.Start(new ProcessStartInfo(address) { UseShellExecute = true }); }
        catch { MessageBox.Show("服务已启动，请在浏览器打开：\n" + address, "漫译", MessageBoxButtons.OK, MessageBoxIcon.Information); }

        Application.EnableVisualStyles();
        NotifyIcon tray = new NotifyIcon();
        tray.Icon = SystemIcons.Application;
        tray.Text = "漫译 · 本地漫画翻译 (11451)";
        ContextMenuStrip menu = new ContextMenuStrip();
        ToolStripMenuItem open = new ToolStripMenuItem("打开漫译网页");
        open.Click += delegate { try { Process.Start(new ProcessStartInfo(address) { UseShellExecute = true }); } catch { } };
        ToolStripMenuItem exit = new ToolStripMenuItem("退出并关闭服务");
        exit.Click += delegate { tray.Visible = false; tray.Dispose(); listener.Stop(); Application.ExitThread(); };
        menu.Items.Add(open);
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add(exit);
        tray.ContextMenuStrip = menu;
        tray.DoubleClick += delegate { try { Process.Start(new ProcessStartInfo(address) { UseShellExecute = true }); } catch { } };
        tray.Visible = true;
        Application.Run(new ApplicationContext());
        tray.Visible = false;
        tray.Dispose();
        listener.Stop();
    }

    private static void ConfigureTls()
    {
        // This binary targets .NET 4.0, whose legacy defaults are SSL3/TLS1.0.
        // TLS 1.2's numeric value keeps compilation compatible with its compiler.
        // Certificate validation remains enabled; never downgrade after failure.
        ServicePointManager.SecurityProtocol = (SecurityProtocolType)3072;
    }

    private static void AcceptLoop(TcpListener listener)
    {
        while (true)
        {
            TcpClient client;
            try { client = listener.AcceptTcpClient(); }
            catch { return; }
            ThreadPool.QueueUserWorkItem(delegate(object state) { Handle((TcpClient)state); }, client);
        }
    }

    private static void Handle(TcpClient client)
    {
        using (client)
        using (NetworkStream stream = client.GetStream())
        {
            stream.ReadTimeout = 120000;
            string header;
            try { header = ReadHeader(stream); }
            catch { return; }
            if (String.IsNullOrEmpty(header)) return;
            string[] lines = header.Split(new[] { "\r\n" }, StringSplitOptions.None);
            string[] first = lines[0].Split(' ');
            if (first.Length < 2) { WriteResponse(stream, 400, "Bad Request", "text/plain; charset=utf-8", Encoding.UTF8.GetBytes("Bad request")); return; }
            string method = first[0].ToUpperInvariant();
            string path = first[1].Split('?')[0];
            int contentLength = 0;
            foreach (string line in lines)
            {
                if (line.StartsWith("Content-Length:", StringComparison.OrdinalIgnoreCase)) Int32.TryParse(line.Substring(15).Trim(), out contentLength);
            }
            if (contentLength < 0 || contentLength > 60 * 1024 * 1024) { WriteResponse(stream, 413, "Payload Too Large", "application/json; charset=utf-8", ErrorJson("请求体过大，请将图片缩小后重试。")); return; }
            if (path == "/api/proxy" && method == "POST")
            {
                byte[] body = ReadBody(stream, contentLength);
                Proxy(stream, body);
                return;
            }
            if (method != "GET" && method != "HEAD") { WriteResponse(stream, 405, "Method Not Allowed", "text/plain; charset=utf-8", Encoding.UTF8.GetBytes("Method not allowed")); return; }
            ServeFile(stream, path, method == "HEAD");
        }
    }

    private static string ReadHeader(NetworkStream stream)
    {
        StringBuilder b = new StringBuilder();
        int state = 0;
        while (b.Length < 65536)
        {
            int v = stream.ReadByte();
            if (v < 0) break;
            char c = (char)v;
            b.Append(c);
            if ((state == 0 || state == 2) && c == '\r') state++;
            else if ((state == 1 || state == 3) && c == '\n') { state++; if (state == 4) break; }
            else state = c == '\r' ? 1 : 0;
        }
        return b.ToString();
    }

    private static byte[] ReadBody(NetworkStream stream, int length)
    {
        byte[] body = new byte[length];
        int offset = 0;
        while (offset < length)
        {
            int count = stream.Read(body, offset, length - offset);
            if (count <= 0) throw new EndOfStreamException();
            offset += count;
        }
        return body;
    }

    private static void Proxy(NetworkStream stream, byte[] requestBytes)
    {
        try
        {
            Dictionary<string, object> request = Json.Deserialize<Dictionary<string, object>>(Encoding.UTF8.GetString(requestBytes));
            string url = Convert.ToString(request["url"]);
            string key = Convert.ToString(request["key"]);
            object payload = request["payload"];
            if (!url.StartsWith("https://", StringComparison.OrdinalIgnoreCase) && !url.StartsWith("http://", StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("接口地址必须以 http:// 或 https:// 开头。");
            byte[] data = Encoding.UTF8.GetBytes(Json.Serialize(payload));
            HttpWebRequest upstream = (HttpWebRequest)WebRequest.Create(url);
            upstream.Method = "POST";
            upstream.ContentType = "application/json";
            upstream.Accept = "application/json";
            upstream.Timeout = 180000;
            upstream.ReadWriteTimeout = 180000;
            upstream.Headers[HttpRequestHeader.Authorization] = "Bearer " + key;
            upstream.ContentLength = data.Length;
            using (Stream outStream = upstream.GetRequestStream()) outStream.Write(data, 0, data.Length);
            try
            {
                using (HttpWebResponse response = (HttpWebResponse)upstream.GetResponse())
                using (Stream input = response.GetResponseStream())
                using (MemoryStream output = new MemoryStream())
                {
                    input.CopyTo(output);
                    WriteResponse(stream, (int)response.StatusCode, response.StatusDescription, "application/json; charset=utf-8", output.ToArray());
                }
            }
            catch (WebException ex)
            {
                HttpWebResponse response = ex.Response as HttpWebResponse;
                if (response == null) throw;
                using (response)
                using (Stream input = response.GetResponseStream())
                using (MemoryStream output = new MemoryStream())
                {
                    input.CopyTo(output);
                    WriteResponse(stream, (int)response.StatusCode, response.StatusDescription, "application/json; charset=utf-8", output.ToArray());
                }
            }
        }
        catch (Exception ex)
        {
            WebException networkError = ex as WebException;
            string error = "本机代理请求失败：" + ex.Message;
            if (networkError != null && (networkError.Status == WebExceptionStatus.SecureChannelFailure || networkError.Status == WebExceptionStatus.TrustFailure))
                error = "HTTPS 安全连接失败。请确认已退出旧版托盘程序并启动更新后的 EXE；若仍失败，请检查电脑时间、系统证书和 HTTPS 代理。原始错误：" + ex.Message;
            WriteResponse(stream, 502, "Bad Gateway", "application/json; charset=utf-8", ErrorJson(error));
        }
    }

    private static byte[] ErrorJson(string message) { return Encoding.UTF8.GetBytes(Json.Serialize(new Dictionary<string, string> { { "message", message } })); }

    private static void ServeFile(NetworkStream stream, string path, bool head)
    {
        try
        {
            if (path == "/") path = "/index.html";
            string relative = Uri.UnescapeDataString(path.TrimStart('/').Replace('/', Path.DirectorySeparatorChar));
            string full = Path.GetFullPath(Path.Combine(Root, relative));
            string rootPrefix = Root.EndsWith(Path.DirectorySeparatorChar.ToString(), StringComparison.Ordinal) ? Root : Root + Path.DirectorySeparatorChar;
            if (!full.StartsWith(rootPrefix, StringComparison.OrdinalIgnoreCase) || !File.Exists(full)) { WriteResponse(stream, 404, "Not Found", "text/plain; charset=utf-8", Encoding.UTF8.GetBytes("Not found")); return; }
            string ext = Path.GetExtension(full).ToLowerInvariant();
            string type = ext == ".html" ? "text/html; charset=utf-8" : ext == ".js" ? "application/javascript; charset=utf-8" : ext == ".css" ? "text/css; charset=utf-8" : ext == ".ttf" ? "font/ttf" : ext == ".woff2" ? "font/woff2" : "application/octet-stream";
            byte[] bytes = File.ReadAllBytes(full);
            WriteResponse(stream, 200, "OK", type, head ? new byte[0] : bytes, head ? bytes.Length : (long?)null);
        }
        catch { WriteResponse(stream, 500, "Internal Server Error", "text/plain; charset=utf-8", Encoding.UTF8.GetBytes("Unable to serve file")); }
    }

    private static void WriteResponse(NetworkStream stream, int status, string reason, string contentType, byte[] body, long? specifiedLength = null)
    {
        try
        {
            string header = "HTTP/1.1 " + status + " " + reason + "\r\nContent-Type: " + contentType + "\r\nContent-Length: " + (specifiedLength.HasValue ? specifiedLength.Value : body.Length) + "\r\nConnection: close\r\nCache-Control: no-cache\r\nX-Content-Type-Options: nosniff\r\n\r\n";
            byte[] bytes = Encoding.ASCII.GetBytes(header);
            stream.Write(bytes, 0, bytes.Length);
            if (body.Length > 0) stream.Write(body, 0, body.Length);
            stream.Flush();
        }
        catch { }
    }
}
