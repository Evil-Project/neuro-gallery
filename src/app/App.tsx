import { ChangeEvent, DragEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  Aperture,
  ArrowUpRight,
  Copy,
  Dices,
  ImagePlus,
  KeyRound,
  Loader2,
  LogIn,
  LogOut,
  RefreshCw,
  ShieldCheck,
  Trash2,
  UploadCloud,
} from "lucide-react";
import { deleteImage, fetchAuthSession, fetchImages, fetchRandomImage, login, logout, uploadImages } from "./api";
import type { GalleryImage } from "./types";

type Status = "idle" | "loading" | "uploading" | "randomizing" | "deleting";
type AuthStatus = "checking" | "idle" | "signing-in" | "signing-out";

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const ACCEPTED_TYPES = ["image/avif", "image/gif", "image/jpeg", "image/png", "image/svg+xml", "image/webp"];

export function App() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [images, setImages] = useState<GalleryImage[]>([]);
  const [randomImage, setRandomImage] = useState<GalleryImage | null>(null);
  const [status, setStatus] = useState<Status>("loading");
  const [dragging, setDragging] = useState(false);
  const [message, setMessage] = useState("Loading image pool...");
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [authenticated, setAuthenticated] = useState(false);
  const [authStatus, setAuthStatus] = useState<AuthStatus>("checking");
  const [password, setPassword] = useState("");

  const latestImages = useMemo(() => images.slice(0, 8), [images]);
  const randomUrl = randomImage ? new URL(randomImage.url, window.location.origin).toString() : "";
  const redirectUrl = new URL("/random", window.location.origin).toString();

  useEffect(() => {
    let mounted = true;

    Promise.all([fetchImages(), fetchAuthSession()])
      .then(([items, sessionAuthenticated]) => {
        if (!mounted) {
          return;
        }

        setImages(items);
        setAuthenticated(sessionAuthenticated);
        setRandomImage(items[0] ?? null);
        setMessage(items.length ? `${items.length} image${items.length === 1 ? "" : "s"} ready.` : "Upload images to seed the random API.");
      })
      .catch((err: Error) => {
        if (mounted) {
          setError(err.message);
          setMessage("The gallery could not be loaded.");
        }
      })
      .finally(() => {
        if (mounted) {
          setStatus("idle");
          setAuthStatus("idle");
        }
      });

    return () => {
      mounted = false;
    };
  }, []);

  async function handleUpload(files: File[]) {
    if (!authenticated) {
      setError("Sign in to upload images.");
      return;
    }

    const imageFiles = validateFiles(files);

    if (!imageFiles.length) {
      return;
    }

    setError("");
    setCopied(false);
    setStatus("uploading");
    setMessage(`Uploading ${imageFiles.length} image${imageFiles.length === 1 ? "" : "s"}...`);

    try {
      const uploaded = await uploadImages(imageFiles);
      const nextImages = await fetchImages();

      setImages(nextImages);
      setRandomImage(uploaded[0] ?? nextImages[0] ?? null);
      setMessage(`${uploaded.length} upload${uploaded.length === 1 ? "" : "s"} added to the random pool.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed.");
      setMessage("Upload failed.");
    } finally {
      setStatus("idle");
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    }
  }

  async function pickRandom() {
    setError("");
    setCopied(false);
    setStatus("randomizing");
    setMessage("Selecting from the image pool...");

    try {
      const image = await fetchRandomImage();
      setRandomImage(image);
      setMessage(`Random API selected ${image.name}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No random image is available.");
      setMessage("The random API needs at least one upload.");
    } finally {
      setStatus("idle");
    }
  }

  async function removeImage(id: string) {
    if (!authenticated) {
      setError("Sign in to remove images.");
      return;
    }

    setStatus("deleting");
    setError("");

    try {
      await deleteImage(id);
      const nextImages = images.filter((image) => image.id !== id);
      setImages(nextImages);
      setRandomImage((current) => (current?.id === id ? nextImages[0] ?? null : current));
      setMessage("Image removed from the random pool.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Delete failed.");
    } finally {
      setStatus("idle");
    }
  }

  async function copyRandomEndpoint() {
    await navigator.clipboard.writeText(redirectUrl);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  }

  async function signIn() {
    if (!password) {
      setError("Enter the upload password.");
      return;
    }

    setError("");
    setAuthStatus("signing-in");

    try {
      const nextAuthenticated = await login(password);
      setAuthenticated(nextAuthenticated);
      setPassword("");
      setMessage("Upload session active.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign in failed.");
    } finally {
      setAuthStatus("idle");
    }
  }

  async function signOut() {
    setError("");
    setAuthStatus("signing-out");

    try {
      await logout();
      setAuthenticated(false);
      setMessage("Upload session closed.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign out failed.");
    } finally {
      setAuthStatus("idle");
    }
  }

  function validateFiles(files: File[]) {
    const valid = files.filter((file) => {
      if (!ACCEPTED_TYPES.includes(file.type)) {
        setError(`${file.name} is not a supported image type.`);
        return false;
      }

      if (file.size > MAX_UPLOAD_BYTES) {
        setError(`${file.name} is larger than 10 MB.`);
        return false;
      }

      return true;
    });

    return valid;
  }

  function onInputChange(event: ChangeEvent<HTMLInputElement>) {
    handleUpload(Array.from(event.target.files ?? []));
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragging(false);
    handleUpload(Array.from(event.dataTransfer.files));
  }

  const busy = status !== "idle" || authStatus === "checking";
  const authBusy = authStatus === "signing-in" || authStatus === "signing-out";

  return (
    <main className="shell">
      <section className="workspace" aria-label="Neuro Gallery image API">
        <aside className="control-rail">
          <div className="brand-mark" aria-label="Neuro Gallery">
            <Aperture size={24} strokeWidth={1.8} />
          </div>

          <button
            className="icon-button"
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={busy || !authenticated}
            title="Upload images"
            aria-label="Upload images"
          >
            <ImagePlus size={22} />
          </button>

          <button
            className="icon-button"
            type="button"
            onClick={pickRandom}
            disabled={busy || images.length === 0}
            title="Pick random image"
            aria-label="Pick random image"
          >
            <Dices size={22} />
          </button>

          <button
            className="icon-button"
            type="button"
            onClick={() => fetchImages().then(setImages).catch((err: Error) => setError(err.message))}
            disabled={busy}
            title="Refresh gallery"
            aria-label="Refresh gallery"
          >
            <RefreshCw size={21} />
          </button>
        </aside>

        <section className="main-stage">
          <header className="topline">
            <div>
              <p className="eyebrow">Random image API</p>
              <h1>Neuro Gallery</h1>
            </div>
            <div className="metric-cluster" aria-label="Gallery statistics">
              <span>{images.length}</span>
              <small>images live</small>
            </div>
          </header>

          <section className="hero-panel">
            <div className="preview-frame">
              {randomImage ? (
                <img src={randomImage.url} alt={randomImage.name} />
              ) : (
                <div className="empty-preview">
                  <UploadCloud size={48} />
                  <span>No images yet</span>
                </div>
              )}
            </div>

            <div className="action-panel">
              <div>
                <p className="label">Current random output</p>
                <h2>{randomImage ? randomImage.name : "Waiting for uploads"}</h2>
                <p className="status-copy">{error || message}</p>
              </div>

              <div className="endpoint-card">
                <span>/random</span>
                <button type="button" onClick={copyRandomEndpoint} title="Copy endpoint" aria-label="Copy random endpoint">
                  <Copy size={17} />
                </button>
              </div>

              <div className="button-row">
                <button className="primary-button" type="button" onClick={pickRandom} disabled={busy || images.length === 0}>
                  {status === "randomizing" ? <Loader2 className="spin" size={18} /> : <Dices size={18} />}
                  Random
                </button>
                <a className={`secondary-button ${randomImage ? "" : "disabled"}`} href={randomUrl || undefined} target="_blank" rel="noreferrer">
                  <ArrowUpRight size={18} />
                  Open
                </a>
              </div>

              <p className="hint">{copied ? "Endpoint copied." : "/api/random?format=json"}</p>
            </div>
          </section>
        </section>

        <aside className="gallery-panel">
          <form
            className={`auth-panel ${authenticated ? "authenticated" : ""}`}
            onSubmit={(event) => {
              event.preventDefault();
              if (authenticated) {
                signOut();
              } else {
                signIn();
              }
            }}
          >
            <div className="auth-copy">
              {authenticated ? <ShieldCheck size={22} /> : <KeyRound size={22} />}
              <div>
                <strong>{authenticated ? "Uploader signed in" : "Uploader sign in"}</strong>
                <span>{authenticated ? "Mutations unlocked" : "Password required"}</span>
              </div>
            </div>

            {authenticated ? (
              <button className="auth-button" type="submit" disabled={authBusy}>
                {authStatus === "signing-out" ? <Loader2 className="spin" size={17} /> : <LogOut size={17} />}
                Sign out
              </button>
            ) : (
              <div className="auth-fields">
                <input
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  placeholder="Upload password"
                  autoComplete="current-password"
                  disabled={authBusy}
                />
                <button className="auth-button" type="submit" disabled={authBusy}>
                  {authStatus === "signing-in" ? <Loader2 className="spin" size={17} /> : <LogIn size={17} />}
                  Sign in
                </button>
              </div>
            )}
          </form>

          <div
            className={`drop-zone ${dragging ? "dragging" : ""} ${authenticated ? "" : "locked"}`}
            onDragEnter={(event) => {
              event.preventDefault();
              if (authenticated) {
                setDragging(true);
              }
            }}
            onDragLeave={(event) => {
              event.preventDefault();
              setDragging(false);
            }}
            onDragOver={(event) => event.preventDefault()}
            onDrop={onDrop}
            role="button"
            tabIndex={0}
            onClick={() => {
              if (authenticated) {
                fileInputRef.current?.click();
              } else {
                setError("Sign in to upload images.");
              }
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                if (authenticated) {
                  fileInputRef.current?.click();
                }
              }
            }}
          >
            <input
              ref={fileInputRef}
              className="file-input"
              type="file"
              accept={ACCEPTED_TYPES.join(",")}
              multiple
              disabled={!authenticated || busy}
              onChange={onInputChange}
            />
            <UploadCloud size={24} />
            <div>
              <strong>{authenticated ? (status === "uploading" ? "Uploading..." : "Drop images") : "Upload locked"}</strong>
              <span>{authenticated ? "PNG, JPEG, WebP, AVIF, GIF, SVG up to 10 MB" : "Sign in first"}</span>
            </div>
          </div>

          <div className="gallery-header">
            <span>Latest uploads</span>
            <small>{status === "loading" ? "Loading" : `${images.length} total`}</small>
          </div>

          <div className="image-list" aria-live="polite">
            {latestImages.length ? (
              latestImages.map((image) => (
                <article className="image-row" key={image.id}>
                  <button
                    className="thumb-button"
                    type="button"
                    onClick={() => setRandomImage(image)}
                    title={`Preview ${image.name}`}
                    aria-label={`Preview ${image.name}`}
                  >
                    <img src={image.url} alt="" />
                  </button>
                  <div className="row-copy">
                    <strong>{image.name}</strong>
                    <span>{formatBytes(image.size)} · {formatDate(image.uploadedAt)}</span>
                  </div>
                  <button
                    className="delete-button"
                    type="button"
                    onClick={() => removeImage(image.id)}
                    disabled={status === "deleting" || !authenticated}
                    title={authenticated ? "Delete image" : "Sign in to delete"}
                    aria-label={`Delete ${image.name}`}
                  >
                    <Trash2 size={17} />
                  </button>
                </article>
              ))
            ) : (
              <div className="empty-list">
                <ImagePlus size={28} />
                <span>No uploads yet.</span>
              </div>
            )}
          </div>
        </aside>
      </section>
    </main>
  );
}

function formatBytes(bytes: number) {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = units.shift() ?? "KB";

  while (value >= 1024 && units.length) {
    value /= 1024;
    unit = units.shift() ?? unit;
  }

  return `${value.toFixed(value >= 10 ? 0 : 1)} ${unit}`;
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
  }).format(new Date(value));
}
