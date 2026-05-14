from django.urls import path
from apps.core.admin_views import AdminDashboardView, UploadFuelPricesView, UploadDistanceTableView

urlpatterns = [
    path('', AdminDashboardView.as_view(), name='admin_dashboard'),
    path('upload/fuel/', UploadFuelPricesView.as_view(), name='upload_fuel_prices'),
    path('upload/distances/', UploadDistanceTableView.as_view(), name='upload_distance_table'),
]
