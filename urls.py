from django.contrib import admin
from django.urls import path, include
from django.conf import settings
from django.conf.urls.static import static
from django.views.generic import RedirectView

urlpatterns = [
    path('admin/', admin.site.norm_url if hasattr(admin.site, 'norm_url') else admin.site.urls), # Standard Django admin
    # HTMS Apps
    path('accounts/', include('apps.accounts.urls')),
    path('admin-panel/', include('htms.admin_urls')), 
    
    # Core reference and home apps
    path('', include('apps.core.urls')),

    # Stubs for other apps
    path('trips/', include('apps.trips.urls')),
    path('invoices/', include('apps.trips.invoice_urls')),
    path('reports/', include('apps.reports.urls')),
    path('debug-pdf/', __import__('apps.documents.views', fromlist=['debug_pdf_test']).debug_pdf_test, name='debug_pdf_test'),
]

if settings.DEBUG:
    urlpatterns += static(settings.MEDIA_URL, document_root=settings.MEDIA_ROOT)
    urlpatterns += static(settings.STATIC_URL, document_root=settings.STATIC_ROOT)
