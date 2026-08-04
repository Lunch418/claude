<?php
class ExportController {

    private const EXPORTS_DIR = '/storage/exports';
    private const MAX_AGE_SEC = 3600; // удалять файлы старше 1 часа

    private function exportsDir(): string {
        return dirname(__DIR__, 2) . self::EXPORTS_DIR;
    }

    // Удаляем старые CSV-файлы — вызывается при каждом download()
    private function cleanOldExports(): void {
        $dir = $this->exportsDir();
        if (!is_dir($dir)) return;
        $now = time();
        foreach (glob($dir . '/*.csv') as $file) {
            if (is_file($file) && ($now - filemtime($file)) > self::MAX_AGE_SEC) {
                @unlink($file);
            }
        }
    }

    public function download(): void {
        if (empty($_SESSION['sed_user'])) {
            http_response_code(401);
            exit('Unauthorized');
        }

        $id = preg_replace('/[^a-z0-9_.\-]/i', '', $_GET['id'] ?? '');

        if ($id === '' || str_contains($id, '..') || str_contains($id, '/')) {
            http_response_code(400);
            exit('Bad id');
        }

        $path       = $this->exportsDir() . '/' . $id . '.csv';
        $realPath   = realpath($path);
        $exportsDir = realpath($this->exportsDir());

        if ($realPath === false || $exportsDir === false
            || !str_starts_with($realPath, $exportsDir)) {
            http_response_code(400);
            exit('Bad id');
        }

        if (!file_exists($realPath)) {
            http_response_code(404);
            exit('Not found');
        }

        // Чистим старые файлы
        $this->cleanOldExports();

        header('Content-Type: text/csv; charset=utf-8');
        header('Content-Disposition: attachment; filename="export_' . $id . '.csv"');
        header('Content-Length: ' . filesize($realPath));
        header('Cache-Control: no-store');
        readfile($realPath);
    }
}
